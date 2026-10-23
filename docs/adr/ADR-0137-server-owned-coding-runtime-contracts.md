# ADR-0137: Server-owned Coding Workbench runtime contracts and authority

## Status

Accepted (Issue #2252, 2026-07-11).

## Context

The Epic #1982 acceptance audit found that the original Coding Workbench contracts could describe
an Authority Envelope assembled by a browser and a runtime event stream without defining the
trusted aggregate that owns launch intent, active-run state, task-workspace binding, revocation, and
action-bound replay protection. Confirmation of caller-authored authority is not server minting. A runtime
adapter must never receive browser-authored paths, arguments, endpoints, environment, credentials,
deployment ceilings, scopes, budgets, or project roots.

ADR-0124 and ADR-0125 remain correct about the three machine modes, their display semantics, the
resource/risk matrix, separately approved delivery, and editor-agent compatibility. This decision
corrects only the missing runtime ownership and delegation boundary. It does not activate a process,
implement an adapter, execute a connector, or add a browser route.

Production route and orchestrator migration was deferred to Issue #2256, which left the
client-envelope runtime routes unmounted, and Issue #2958 (audit KEIKO-0115/KEIKO-0135) then deleted
them along with the policy and approval store behind them:
`POST /api/coding-workbench/autonomous-delivery/{confirm,execute}` and
`POST /api/editor/agent/authority` no longer exist as code, and `routes.test.ts` pins all three
patterns as unmatched. The single mounted autonomous coding-delivery authority path is
`CODING_RUNTIME_ROUTE_GROUP`, whose envelopes are minted by
`runtimeAuthorityService.confirmStart`; every state-changing Git delivery operation is admitted by
`gitDelivery/runBoundAuthority.authorizeGitDelivery` against that accepted run and gated by the
one-use `gitDelivery/approvalStore`.

## Decision

### D1 — Browser input is intent, never authority

The closed start request contains only a request id, transient task intent, requested mode, and
model source. Stop, takeover, and recovery requests contain only a request id and run id. Exact-key
validation rejects every additional field. Raw task intent is transient model input and is absent
from durable runtime state, events, failures, and evidence.

The pinned OpenCode 2.0.10 V2 launch configuration does not override `agents.build.system` or
`agents.compaction.system`. OpenCode owns the Build prompt, model optimizers, planning, native
iteration and compaction. One generated plugin uses the supported `session.hook("context")` to
append a separate text part with the Keiko tool/authority interface, truthful verification results
and repository-instruction framing. It leaves native system parts, messages and tools intact; it
adds no planner, tool selector or execution loop. The existing readiness operation records only
the configured addendum's SHA-256 and UTF-8 byte count at config materialization. `configDigest`
still identifies the configuration JSON; these configured facts do not claim provider receipt.
An actual request through the pinned executable separately proves native base guidance plus the
exact additive part. Legacy V1 retains its existing prompt/configuration contract.

Issue #3385 adds an optional raw `issueRef` and accepted-preview digest to that intent. A paired
local app session and the selected checkout's existing GitHub reader grant admit preview reads.
The browser receives only the shared preview projection and bounded untrusted excerpts; it cannot
submit a binding or select the issue's base branch. Existing task-workspace provisioning resolves
the default base server-side and rechecks the accepted digest before creating a workspace.

Before minting an issue-bound run, the server resolves the issue again and rejects PRs, closed or
unreadable issues, changed provenance, stale content and missing authority. The immutable GitHub
node id, canonical remote digest, checkout id, issue number, default base and content revision are
bound into the existing execution binding and start confirmation. The same closed issue validator
guards authority, public snapshots and the durable ledger. Retrying revalidates the previous
binding; generic tasks retain their existing behavior. Bounded issue text enters only the initial
model turn through the existing context-pack builder and never enters the durable projections.
The orchestrator keeps the human task intent unchanged and carries labelled untrusted context in a
separate server-only `initialContext` dispatch field. Explicit-skill tracking observes only the
human text. The pinned OpenCode 2.0.10 prompt transport prepends the labelled initial context to the human
text in the existing bounded prompt and carries `keikoContextPresentationV1` metadata naming the
human display text and the hidden context digest. The safe-activity projection verifies that
binding and shows only the human text.
The combined prompt retains the existing byte ceiling. The Codex control port currently accepts
only text, so its adapter composes the same labelled context after explicit-skill tracking; it never
feeds that composed string back into skill authorization. Follow-up turns carry no implicit context.
The existing body-free `coding-runtime.run.issue-context-attached` event records initial attachment;
raw context stays absent from runtime snapshots, generated runtime configuration and activity logs.

The same server-only `initialContext` field also carries the repository's own working instructions
(2026-10-06). For every run the server reads exactly `AGENTS.md` at the task workspace root — no
other file, no parent directory, no symlink — through the same secure workspace read helper that
answers `keiko_workspace_read`, never a second filesystem path. That helper resolves its root from
the global active pointer, so the read is bracketed by the run's own exact-workspace check before
and after it (`exactWorkspaceRead`, shared with the auxiliary ports): a workspace switch while the
run starts is recorded as `refused` with `workspace-unavailable` and never attaches another
repository's file (#3873 review). The model receives the window that read would answer for the
file's first 800 lines, cut at a line boundary to 16,384 bytes and to the bytes the turn still has
under the sidecar prompt ceiling; a cut file ends with one explicit line naming the total line
count. The block rides in the first message and is re-sent with every turn, so the context line
records its estimated tokens, its per-turn cost against the run's prompt allowance. It is framed as
repository-authored, untrusted instructions — conventions and style, and verification guidance that
only selects among the vetted verifiers — that grant no authority: they cannot change the governed
tool rules, the Authority Envelope or the autonomy mode, and when the human intent and the other
context parts already fill the prompt ceiling the instructions yield first. The frame is Keiko's: an
opening and a closing `repository-instructions` tag carrying one nonce drawn after the text exists
and checked against it, so the file cannot close its frame early, and the tag is neutralized in
every other part of the first message (issue, project memory, history), so no other text can forge
the block; the governed system prompt identifies the block by that framing, not by a heading. The
loader is on by default; `KEIKO_CODING_REPOSITORY_INSTRUCTIONS_ENABLED=false` disables it and any
other explicit value fails composition closed. The body-free
`coding-runtime.repository-instructions.context` event records the outcome under the run's
correlation id (`attached`, `truncated`, `absent`, `disabled`, `refused`) with the attached byte and
line counts, the file's total counts when cut, and the whole-file SHA-256 the read tool reports for
the same file; only a genuine read failure is `refused`, recorded at `warn` with its closed reason,
and it never fails the run. The helper reports a missing root file and a denied one alike, so both
are `absent` with the helper's own reason retained. The helper delivers whole files up to its
content ceiling of 1 MiB, pinned in its wire protocol and its digest-pinned native binary. This
bounded whole-file read admits ordinary large repository instructions and retains the whole-file
digest for edit preconditions. The native helper allocates only the observed file size plus one
growth-detection byte; it still checks final file and directory identity and rejects concurrent
changes. Model-facing read windows remain capped at 64 KiB, and initial repository instructions
remain capped at 16 KiB and 800 lines. An oversized requested model window returns the existing
`workspace-read-too-large` refusal and a body-free failed-read event so the model can request a
smaller line window. Files above 1 MiB remain refused; neither a tool argument nor this loader can
override the pinned helper ceiling.

An application upgrade may still resolve the immutable npm runtime 1.1.3. Its previously approved
helper digests remain admitted with their original 64 KiB wire capability; unknown bytes remain
refused. The verified artifact, never a tool argument, selects one of the two closed protocol caps.
A legacy helper response above its own cap is rejected even though the current response codec can
carry 1 MiB. Current helper approvals are rebuilt from the checked-in native source for both macOS
architectures. `coding-runtime.dev-lane.activated` records the selected helper digest and byte cap,
so support can distinguish an old installed helper from the current one. A release that delivers
large-file reads must also publish and select the rebuilt runtime packages; application-only
updates keep the legacy bound rather than breaking ordinary reads.

### D2 — One server aggregate owns runtime authority

The BFF resolves the authenticated local operator and the live active task workspace before minting.
It also resolves project identity/digest, workspace root/digest, task and branch facts, deployment
ceiling, action classes, connector/network scopes, model/runtime sources, command policy, gates,
budgets, and expiry. The effective mode remains the fail-closed minimum from ADR-0124/0125.

The resulting runtime envelope composes the existing `CodingWorkbenchAuthorityEnvelope` with an
immutable execution binding and digests of transient intent and a fresh nonce. It is registered with
the existing editor-agent authority registry; a second authority stack is not introduced. Only an
opaque run id and envelope digest cross into the adapter seam.

Minting requires a server-issued, action-bound, one-use human confirmation. The Authority Envelope
itself is retained for the complete run so the existing registry remains the sole source of
cumulative runtime/tool/patch budgets. Two of those bounds are operator settings, read once at
composition and copied into every newly minted envelope: the cumulative prompt-token allowance
`KEIKO_CODING_RUNTIME_MAX_PROMPT_TOKENS` (default 2,000,000; positive decimal integers up to
20,000,000) and the envelope duration `KEIKO_CODING_RUNTIME_MAX_DURATION_MINUTES` (default 120;
positive decimal integers from 1 to 480), from which both `budget.maxRuntimeMs` and `expiresAt`
derive. An invalid value fails the composition closed; neither setting can alter an existing
envelope or reset its usage, and a run that exhausts either bound still fails closed at its next
delegation. Native context compaction changes subsequent request size, not cumulative accounting.

The pinned V2 runtime's admitted compaction history projects running, retained-tail, completed, and
failed facts onto the existing `coding-runtime.compaction` Activity Log operation. Native compaction
identifiers are hashed; summary text, retained-tail content, model/provider state, and error bodies
never enter that operational projection. V2's `recent` is serialized content, not a message ID:
only its presence determines the retained-tail boolean, and its unavailable start-ID digest is
omitted. Lifecycle metadata, rather than streaming summary text, drives deduplication. V2 does not
report the V1 overflow boolean: its absence means unavailable and must never be recorded as `false`.
Unknown lifecycle variants, unexpected top-level fields, and missing or malformed required lifecycle
fields fail closed. Optional provider and usage payloads are not decoded or projected by this
observation lane. Compaction failure remains an observation; native execution settlement owns task
completion, so an answer or summary cannot bypass pending tools or verification repair. Automatic
compaction configuration and execution ordering remain native-runtime concerns; the historical
post-answer delay remains open until a reproducible native qualification identifies the cause.

The allowance is the only default per-run token bound: a Model Gateway spend ceiling is enforced
only where an operator configures one. It therefore counts every prompt the provider processed for
a turn: the turn's own prompt and, when the gateway discarded attempts on the way to its answer (a
steered repair's first answer, a catalog-rejected tool call, a stream that failed after its usage
arrived), their provider-reported prompt tokens (`discardedAttemptUsage`, ADR-0003; #3873 review). The former defaults (200,000 tokens and a fixed 30 minutes)
rested on the premise that only a refused-edit loop exhausts them; the live Gemma qualification
(#3873, run `run-65084062444586162471229658028402064666`, Supervised workspace, Gemma 4 31B behind
LiteLLM) disproved it. An ordinary task — fix 13 ESLint findings across six files, then run
`npm run check` — ran 17 model turns in 27.5 minutes with all three replacement edits applied first
time and no refused edit, yet every turn re-sends the whole conversation, so the prompt grew from
4,128 to 18,520 tokens per turn, the cumulative sum reached 200,000, the gateway rejected turn 18
(`coding-sidecar.gateway.rejected`, `runtime-prompt-budget-denied`) and the run settled `failed`.
A slow self-hosted model (about 24 tokens/s, 1,600 to 4,400 mostly-reasoning completion tokens per
turn) likewise turns a fixed 30-minute duration into a wall that ordinary multi-file tasks hit. The
minted allowance and duration are reported body-free as `maxPromptTokens` and `maxRuntimeMs` on
`coding-runtime.authority.minted`. Every other bound that must not be shorter than the run follows
the configured duration: the safe-activity projection retains a run's feed for the duration plus a
margin, and the OpenCode adapter bounds one submitted task's whole agent loop by the run's
`maxRuntimeMs`. Per-request provider deadlines (the gateway floors and the child's chunk watchdog)
are unchanged because they bound one model request, not the run.
Each adapter delegation has a fresh idempotency/replay
identity. Before every delegation, the BFF re-resolves live facts and rejects task, workspace,
project, branch, action/connector scope, budget, runtime source, or model source drift. Expiry,
delegation replay, stop, and takeover fail closed. V1 permits exactly one active run per BFF; a
concurrent start returns `active-run-conflict` deterministically.

**Default envelope widened — owner decision (2026-10-07, PR #3876).** Raising the two defaults
widens the default Authority Envelope of every installation: ten times the prompt-token allowance,
four times the duration, and with `expiresAt` a minted run capability that lives up to 120 minutes
instead of 30. The owner decided to ship these defaults (2,000,000 tokens, 120 minutes) for every
installation, with the two variables as the operator's opt-down, rather than a tighter compromise:
the measured need of ordinary multi-file tasks on self-hosted reasoning models exceeds the former
defaults (above), and a run still fails closed at either bound. Operators who meter a paid provider
set `KEIKO_CODING_RUNTIME_MAX_PROMPT_TOKENS` and `KEIKO_CODING_RUNTIME_MAX_DURATION_MINUTES` before
the server starts, and configure a Model Gateway spend ceiling where they need a per-provider cost
bound. Release note: "Coding Workbench runs now allow up to 2,000,000 prompt tokens and 120 minutes
by default (previously 200,000 tokens and 30 minutes); lower them with
`KEIKO_CODING_RUNTIME_MAX_PROMPT_TOKENS` and `KEIKO_CODING_RUNTIME_MAX_DURATION_MINUTES`."

The same aggregate answers a budget question without spending: `delegationFits` says whether one
more delegation of a given usage would still fit the run's budget, for the same capability, run and
binding a delegation is admitted on, and reserves neither budget nor replay identity. Approved-skill
discovery (#3417) lists only the skills the remaining budget can serve by asking it; a skill's own
invocation still charges its one delegated read at the existing boundary. The server-approved skill
catalog is the single authority for which skills a run may invoke: it changes only by admitting a
whole next set as one snapshot with a new revision and digest, and a run's skill invocation is
refused once the catalog it discovered is no longer the one in force.

### D3 — Runtime state and failures are closed

The server-owned state vocabulary is exactly `unavailable`, `idle`, `starting`, `ready`, `running`,
`paused`, `awaiting-approval`, `stopping`, `succeeded`, `failed`, `cancelled`, `taken-over`, and
`recovery-required`. Legal transitions are an explicit total table; unknown states and implicit
self-transitions fail closed. Failure codes distinguish authority resolution, expiry, replay,
revocation, concurrency, and each drift axis without carrying raw process or model content.

The additive V2 interface guidance requires requested implementation to use actual edits and
verification, inspect observed failures and verify the repair without weakening assertions.
OpenCode owns that coding loop. A text-only native terminal turn is not semantic proof that
requested work happened (live qualification F29, #3873). Planning-only tasks and read-only answers
remain valid without invented edits or verification. This guidance does not introduce a keyword
classifier or execute model prose. The existing post-edit and per-target verification continuation
currently remains a bounded completion safeguard where the run has observed required verification;
its removal requires native-loop qualification with truthful settlement preserved. Final
qualification must independently prove the requested read/edit/test journey. The configured
addendum digest identifies Keiko's guidance separately from the launch configuration digest.

**A run whose edits keep being refused settles instead of looping** (F5 of the live Gemma
qualification, #3873). A run whose workspace had no connected Workbench logged eleven
`coding-runtime.edit.refused` lines with `NO_ACTIVE_SESSION` until the operator stopped it: nothing
above the edit port counted the refusals, and the model resent an edit no change of its own could
make apply. Each run's tool facade now reports every applied or refused governed edit, as the model
received it, to the orchestrator, which counts the run's refusals since its last applied edit,
whatever their closed reason codes. (The first version counted refusals with the same code and
restarted on any other; a model that alternated two refusals — an edit that does not match, a stale
re-read, an edit that does not match again — repeated no code, was never bounded and spent the whole
prompt allowance: PR #3876 review.) Other tool calls between two refused edits do not interrupt the
streak — re-reading the file is exactly what the refusal guidance asks for — while an applied edit
ends it. A human's rejection of a change in its review is a decision, never a refusal (ADR-0124 D6),
and an edit whose preparation was cancelled says nothing about the edit: neither counts. Refusals
that land while an operator has the run paused are not counted. Two counts run over the streak. The
refusals the model cannot repair by changing its edit — no connected Workbench editor
(`NO_ACTIVE_SESSION`, `NO_ACTIVE_BRIDGE`), lost workspace access, a denied path or policy
(`OUT_OF_SCOPE`, `POLICY_DENIED`, `APPROVAL_REQUIRED`), a buffer only the operator can save, an
editor or transport fault, and an edit the port refused while preparing it for a cause the model
cannot change (below) — settle the run `failed` with `edits-blocked` once three of them stand in the
streak (`UNREPAIRABLE_EDIT_REFUSAL_BOUND`). Every refusal counts toward the second bound: an edit that
does not apply (`INVALID_EDITS`), a stale base (`CONTENT_HASH_MISMATCH`, `VERSION_MISMATCH`), a
missing precondition, an invalid changeset, or a refusal that carried no closed code keeps its
guidance, and six refusals of any kind in the streak settle the run with `edit-retries-exhausted`
(`REPAIRABLE_EDIT_REFUSAL_BOUND`). A refusal that meets both bounds at once is named by the
unrepairable one: three refusals the environment dictated say more than six of any kind.
`EDIT_PREPARE_FAILED` is classified by its cause, not by its code alone: the edit port gives the
facade the closed step that refused the edit before the editor route saw it and, for a failed
governed read of a file the edit names, the closed read reason, and the facade reports both beside
the code — never to the model. Only an invalid changeset (`changeset-invalid`) is the model's own
input. A lost workspace, a guard or producer binding that no longer holds, an editor context or
mutation lease that could not be had, and a read that did not answer (not text, too large, denied, an
unavailable workspace) are conditions no edit the model writes changes. The escalation writes one
`coding-runtime.run.refusal-escalated` line: `reasonCode` is the latest refusal's closed code;
`refusalClass`, `consecutiveCount`, `bound` and `failureCode` describe the count that met its bound
(`unrepairable` at three for `edits-blocked`, `repairable` at six for `edit-retries-exhausted`);
`refusalCount` and `unrepairableCount` carry both counts; and `prepareCause` and `readReason` are the
latest refusal's closed words when it had them. The run then settles through the same path as a
failed turn, its runtime stopped and its changes kept in the task workspace, and
`coding-runtime.run.settled` carries the cause with `failureBasis: "refusal-escalation"` and
`refusalReasonCode`. The bounds are fixed: every refused attempt resends the run's growing context,
so a loop spends the prompt allowance on nothing.

**A paused run says what it is waiting for.** `paused` covers two different situations and the
operator has to be able to tell them apart, so the snapshot carries an optional `pauseReason` from a
closed vocabulary. Absent means an operator paused the run from the Workbench, which is what
`paused` meant before. A value names a decision only a local human can make, which a governed tool
has met and is waiting in place for; the run returns to `running` when that wait settles, either
way, because the tool then retries the effect or hands the model its refusal.

Such a decision is deliberately NOT an Authority Envelope approval and does not enter the
`awaiting-approval` plane. The first member, `workspace-script-trust`, is the ADR-0147 D3
package-script grant: a hard, mode-independent boundary recorded as a durable workspace record, not
a one-use action authority. Routing it through the approval plane would mint the wrong artifact and,
in `governed-assist`, collapse that mode's separate per-command approval into a workspace trust
grant. The wait a governed tool may hold for such a decision is bounded by the governed tool
invocation's own lifetime, so the tool always answers with its own closed refusal rather than an
opaque expiry; a decision that outlives a single tool call leaves the run to report a truthful
failure rather than a silent success.

**An issue-bound delivery run may not report a delivery it cannot evidence.** A GitHub issue linked
in a Workbench prompt supplies validated, untrusted task context but does not itself request a
commit, push, or pull request. The server still checks the preview digest and active repository,
then attaches the issue text and retains its content-free context identity for retries and history
continuations, without creating a delivery obligation. Workbench prompts use this general agent
conversation path, including natural-language requests to commit or open a PR: native OpenCode
executes the requested tools under the same authority; commit, push, and PR tool outcomes retain
their existing receipt checks. Turn completion is not a commit/push/PR claim. The browser does not infer a
structured workflow from free text. A caller explicitly selecting the structured API
`issuePurpose: "delivery"` retains the delivery binding and settles `succeeded` only when durable server-owned evidence
says something was delivered — a successful verified-commit receipt, or a draft delivery record in a
phase that means an artifact exists. The record of an ATTEMPT is not evidence: a commit proposal
refused for want of verification, a push still awaiting approval, and a delivery in recovery all
persist records while delivering nothing. Without evidence the run settles `failed` with
`delivery-not-evidenced`. Ad-hoc runs are exempt, because one legitimately ends with no commit and
inferring delivery intent from free text would turn honest successes into false failures.

**Under Full access, a run that stops one step short is given a bounded continuation first**
(PR #3452, 2026-09-11). In `autonomous-delivery` the operator's accepted Authority Envelope
authorizes delivery without a per-action approval (D4). When an issue-bound run's model ends a turn normally while no delivery is
evidenced, the orchestrator dispatches a fixed, server-authored continuation into the live session
instead of settling — at most `DELIVERY_CONTINUATION_MAX` (2) times per run, each logged as
`coding-runtime.run.delivery-continued`. The continuation restates only the accepted task's
delivery goal; every effect still goes through the governed tools and nothing widens authority. A
continuation the orchestrator does not send — `coding-runtime.run.delivery-continuation-refused`
with `reason` `dispatch-threw` (with its `errorKind`), `dispatch-refused`, or
`evidence-unreadable` — an exhausted budget, a failed or cancelled turn, and every supervised or ask
run settle exactly as above, and the `delivery-unevidenced` line names how many continuations the
run had. Two outcomes fail safe instead of guessing. Delivery evidence that cannot be read when the
run settles is logged as `coding-runtime.run.delivery-evidence-unreadable` (with its `errorKind`)
and settles the run `recovery-required` rather than `completed` or `delivery-not-evidenced`,
because neither can be established. A continuation whose run an operator stopped or took over while
the dispatch was in flight is abandoned with `reason` `run-superseded`: the run keeps the outcome
the operator's action decided (a stop settles `cancelled`), and the continuation count is
discarded with the run.

**A failed run names the bound or model-call cause that ended it** (F9 of the live Gemma
qualification, #3873). A failed task outcome carries no cause of its own, and settling every one as
`runtime-failed` told an operator "internal error" for runs that had only reached a bound: run
`run-65084062444586162471229658028402064666` used up its prompt allowance, and run
`run-272120967981827964065820685403290179367` reached its 30-minute envelope with a model call in
flight (`coding-sidecar.gateway.outcome` `cancelled`, `cancellationCause=run-stopped`). At
settlement the orchestrator reads, before it stops the runtime, the facts the owning layers hold:
the runtime authority answers whether the run's most recent model-call admission was refused by the
cumulative prompt allowance itself (not by the runtime's time budget, expiry, revocation, or a run
state that admits no model call; a refusal by the run's CI-repair budget answers before the
authority is asked and is recorded in the same place with the closed reason the budget refused with,
and only its own `prompt-budget-exhausted`, which counts the same `maxPromptTokens` over the repair,
is the allowance: every other reason names no allowance, so a repair that spent its failed attempts
or lost its authority never settles as an exhausted prompt allowance, which no setting could fix;
#3873 review) and whether the run's time limit ran out (`maxRuntimeMs` after minting or `expiresAt`,
whichever comes first, or the CI repair's own `deadline-exhausted`, which counts the same
`maxRuntimeMs` over the repair), and the control plane's event
hub keeps the closed cause the coding sidecar gateway reported for the run's most recent failed
model call until a later call of the run is answered, with the gateway's own fact that the provider
could not serve that call. In that order, the run settles `prompt-allowance-exhausted`,
`envelope-duration-exhausted`, `output-exhausted-repeated` (the gateway's `output-exhausted`, which
ends a run only after the gateway's one steered repair or the runtime's retries exhausted the budget
again), `provider-unavailable`, or `model-turn-failed` (any other failed-call cause, which the
failed turn's own frame names), and `runtime-failed` (the runtime crashed or failed internally) only
when no such cause is on record. `provider-unavailable` is the provider that could not be reached,
stopped answering, or stayed down: the gateway's `stream-incomplete` (a timeout, a refused or
dropped connection, a stream that broke before the answer completed), or its `provider-failed`
together with the gateway's fact that the call ended on a retryable provider status (408, 429, 5xx),
a rate limit or an open breaker once its outage window had passed (F10). That fact is positively
identified from the error — `provider-failed` alone still names a provider that rejected the turn,
so a 4xx, a refused credential or a configuration error settles `model-turn-failed` — and it is
published beside the cause, never in the public failure frame: the gateway's
`coding-sidecar.gateway.turn-failed` line carries `providerUnavailable` when it holds, so the
settlement can be traced to the call it read. The streamed path no longer files every gateway error
it has no rule for under `stream-incomplete`: a configuration or egress refusal, an unknown model or
a refused credential is `provider-failed` there as on the buffered path (and, being no outage, is
final for the runtime), so it can no longer settle a run "nothing was rejected, check that the
gateway is running" (PR #3876 review). A run whose refused edits escalated (above) comes before all
of these facts: it settles `edits-blocked` or `edit-retries-exhausted` whatever its last model call
reported. It settles so whatever the stopped runtime's terminal result reports as well: the
escalation is Keiko's own decision to end the run, and a runtime stopped mid-turn reports
`cancelled`; only a runtime that did not stop puts the run into `recovery-required` (F26, #3873 live
qualification). A run that is stopped settles `cancelled`, as before. The Workbench says the run was
stopped and that nothing failed, and never who stopped it: the operator's Stop and `shutdown()` —
which ends the live run when the server goes away (an update, a restart, a machine shutdown) — take
the same stop path, so the settled snapshot and its terminal status event are identical, and only
`coding-runtime.run.shutdown` in the server's Activity Log names a shutdown. An earlier text claimed
"You stopped this run" for every `cancelled` run, which blamed the operator for a restart (#3873
review). Nothing is read from OpenCode's error text. `coding-runtime.run.settled` records the cause
with `failureBasis` (`prompt-allowance`, `envelope-duration`, `model-call-failure`,
`no-model-call-failure`, or `refusal-escalation` for an escalated run) and `modelCallFailure` (a
`provider-unavailable` run that ended on a retryable status names `provider-failed` there), and an
error class that matches it instead of `internal`.

**A settled run carries its effort roll-up** (#3873), so one line answers how many model turns and
tool calls the run made and where its time went. `coding-runtime.run.settled` adds counts and
durations only, each counted in process where it is observed: `wallDurationMs` (creation to
settlement); `modelTurnCount`, `modelDurationMs` and `promptTokensTotal` at the run's model-gateway
capability, where the sidecar gateway reserves a call's prompt estimate immediately before dispatch
and settles it once the provider answered or failed (the admitted reservation answers an opaque call
identity and the settlement names it, so a call is timed from its own reservation and never from
another call's of the same size: pairing by reservation size alone measured a released call and an
answered one from each other's start, PR #3876 review; a released reservation is no call, and a
settled count equal to the reserved estimate may be that estimate, so `promptTokensTotal` is a
lower bound of provider-reported prompt tokens, never an estimate); `toolInvocationCount`,
`workspaceReadCount`, `editCount` and `editRefusedCount` at the run's tool facade, which reports each
answered call's closed action and status (a malformed edit is a refused edit); and
`verificationCount`, `operatorDecisionCount` (an approval decided, or a decision wait that settled
`accepted` or `denied`) and `operatorWaitMs` (time awaiting an approval or paused on a decision) in
the orchestrator. A count nothing was observed for is 0; a run this process did not start carries
`wallDurationMs` alone. Completion tokens are not rolled up: the gateway's run evidence carries a
completion count without saying whether the provider reported it or it was estimated from output
bytes, and the roll-up never presents an estimate as a provider count.

The runtime adapter port accepts only the opaque authority reference, immutable execution binding,
and closed runtime/model sources. Launch paths, argv, environment, endpoint, and credentials are
adapter-internal server concerns deliberately excluded from the public contract.

### D4 — Runtime confinement, transport, and durable evidence remain server-owned

Long-lived managed runtimes execute only inside the active task-workspace confinement boundary and
communicate with the BFF over authenticated loopback IPC. Runtime permission observations are never
authority: filesystem, command, network, connector and delivery effects must remain inside
Keiko's accepted workspace, authority and evidence boundaries. The native OpenCode service owns
planning, context and the coding loop. Preserve its original tool implementations where supported
native hooks plus the process boundary can enforce those contracts; a mapped Keiko tool is an
integration mechanism, not a requirement to replace every native executor. Production currently
continues to deny native workspace effect tools while these boundaries are being qualified.

V2 mapped tools share one supported plugin setup and declare canonical structured outputs beside
their existing model-facing content. Native Code Mode reuses its outer invocation context for
inner calls, so the adapter captures a distinct bounded identity for each inner invocation before
permission or effect IO. Permission proof, effect request and idempotency use that same identity;
direct invocation identities remain unchanged. Completed-parent and supported Scope disposal
checks reject late calls. Native cancellation does not guarantee an `execute.after` hook; current
server authority and budget checks remain mandatory for every request. Code Mode activation still
requires the exact native execute advertisement, permission, network and lifecycle contracts;
the default direct profile retains `codemode: false`. The captured Code Mode profile registers
the same governed inner tools with `codemode: true` and explicitly permits original `execute`.
Its generated source cache is immutable per closed profile; incoming fields cannot select it.

The inactive explicit Code Mode catalog retains the same seventeen governed inner descriptors and
actual handler coverage, while the original native model advertisement exposes only `question`
and `execute`. Its exact OpenCode 2.0.10 execute schema and description come from the original
snapshot/provider producer. The server captures this distinct profile at registry construction;
an incoming model request cannot select it. Projection and handler identities remain profile-bound,
and mixed direct/Code Mode offers, hidden direct calls, schema drift and expired offers are refused.
The ordinary direct profile remains the default with its existing eighteen visible tools. This
profile prerequisite uses the original native execute producer, but does not activate production
native workspace effects or select an unqualified service transport.

The backend captures the selected profile once from the server-owned readiness registry and exposes
an immutable resolver selection. The resolver captures that selection once again when composing its
run tools; later changes to caller-owned input objects do not change the canonical facade binder.
The same selected projection supplies prepared binding, expiry evidence and dispatch digests.
Unknown profiles fail closed and incoming tool fields cannot select a profile. The existing direct
profile and Chat repository search remain unchanged. The same captured selection reaches native configuration and generated plugin materialization.
Enabling an original service host remains a separate prerequisite.

Native composition now captures that same profile for history and safe-activity observation.
Only the explicit Code Mode profile recognizes the original `execute` parent. Each inner action
joins that parent's actual session/message/call identity through the existing bounded correlation
maps, with a private admission callback set only when that request reaches its authorized delegate.
Denied duplicates and replays cannot overwrite the executed child's running or terminal facts.
This projects real Keiko effect settlement; it does not invent persisted native child history.

The inactive fixed external host factory uses original ServerFetch, RequestExecutor and Tool
snapshot algorithms through their supported layer decorators. Provider and governed-tool POST
transports capture separate immutable URL/authentication purposes; ambient model fetch is denied.
The pinned Effect producer's bounded paired trace headers are preserved. The same generated parent
owner closes idempotently on native success, typed failure, defect or interruption, including when
no `execute.after` hook occurs. Original planning, output, progress, native instructions and SQLite
ownership remain intact. Generated modules are fixed builder assets, not run-packet source paths.
This factory still grants no production launch or native effect permission. Current authority,
governed native IO and a freshly attested host launch remain required. The existing facade bridge
closes admission and cancels approvals immediately, but proves drainage only after every admitted
actual delegate promise settles. One bounded coalesced drain wait owns cancellation; a timed-out
attempt retains recovery and authority. Disposal rechecks its cancellation signal and exact run
generation after each await before removing private state. Future native IO must enter this same
effect owner before its drainage can be claimed.

The first macOS filesystem foundation composes read-only accepted-workspace access, writable
private per-run native state and read-only immutable runtime/OS support with the existing exact
gateway and runtime/attested-Git executable policy. Both direct and supervisor-prepared launches
use the same policy producer. Accepted workspace resolver identity and Chat search remain unchanged.
Private per-run state may live in the existing `<workspace>/.keiko` application metadata subtree;
that exact subtree is the writable exception to workspace reads. Its root must not contain the
workspace or overlap the immutable runtime. No external state resolver is introduced. The logged
workspace access fact is `read-only-outside-private-state`.
The kernel enforces the union of admitted roots, not the caller's intent within that union: native
runtime state and Git metadata required by the service are also process-readable. A canonical
native permission hook must separately deny model access to sensitive workspace paths, private
state and realpath escapes before any production native Read/Search/Edit/Shell admission. This
foundation is not full native capability parity and grants no workspace write authority.

The optional server-private regular-text snapshot facet reuses the existing governed read's
preflight, secure helper and postflight. Its additive `KSR2/KSS2` response derives size and
modification time from the same verified stable file descriptor as the text; a refused read emits
neither text nor metadata. Both protocol capability and effective byte cap are bound to the
approved helper identity. Existing `KSR1/KSS1` helpers retain their exact contract and report the
new snapshot capability unavailable. Existing workspace-read evidence records only closed native
IO/instruction purposes and refusal reasons. This bounded text prerequisite does not activate a
native host or qualify original Read paging, directories, media or large-file semantics. Its
optional facade port binds the private `keiko.native.workspace.text.snapshot@1` descriptor through
the existing canonical registry, authority, budget and invocation owners. Only the actual completed
current invocation receives transient text; catalog results contain compact body-free receipts,
and receipt-only replay cannot recover text. Same-descriptor modification times retain every finite
value, including dates before 1970. The private profile is never a model selector and leaves public
direct/Code Mode projections and Chat read/search consumers unchanged.

The inactive original-Read invocation facet attaches one lifetime to the existing claimed catalog
record. The original session/message/call context, path and pagination facts are captured before
admission awaits. One actual catalog invocation ID, authority admission, CI lease and effect-gate
reservation cover the logical Read and its hidden byte/stat/list/instruction IO. Each immutable child ordinal
and digest is claimed on that same record; duplicate or conflicting packets execute nothing. Closing
cuts off new child IO immediately, while held raw promises retain the original reservation until
actual settlement. Canonical terminal confirmation remains separate from physical drainage. This
facet now forwards the existing logged native IO primitives through that same lifetime. Its exact
private descriptor and profile bind a server-owned capture codec; the public read-path parser is
unchanged. Native paths accept up to 4,096 UTF-8 bytes and 64 components, including the accepted root
for directory/stat operations. Original zero-based pagination facts and zero limits remain intact.
The physical gate stays reserved until actual helper settlement even after client cancellation.
Actual original Read output, permission and instruction comparisons cover native bytes, paging,
directory/root, long paths and Read-level PNG/PDF results; media normalization/provider acceptance,
the full original Files surface and real service transport require further integration.
It creates no replay cache of file contents and does not activate a native model-visible tool.

The inactive accepted-initialization callback projects one genuinely accepted STARTING lease
through the existing pending-spawn revalidation owner. Its captured envelope, workspace binding,
deadline and cancellation signal remain current before each native instruction read and after
the callback. It supplies only the existing logged byte/stat/list primitives with the fixed
`native-instructions` purpose; it neither invents a tool context nor consumes model tool calls.
The one-shot scope closes when its callback settles or accepted authority is revoked. Pending raw
IO retains the same physical-work reservation until actual settlement, including when transport
timeout or cancellation has already answered. Accessor, inherited and extra request fields are
refused before IO. Technical failures retain the original unavailable instruction state.
The inactive original service can now enter that callback through the existing authenticated
`/api/coding-sidecar/tool` route. Closed `native-initialization` begin/byte/stat/list/end packets
require the actual prepared host while it is STARTING and the same current accepted root. No
incoming field selects authority, executable, workspace or purpose. Its callback retains the same
physical gate until real IO settles, including after response cancellation and a refused disposal.
Native bytes use the existing KSS3 codec over bounded binary HTTP with backpressure, completion and
buffer wiping; public JSON/text limits retain their contracts. The existing Activity Log records
body-free initialization-transport begin/end outcomes. A controlled original initial graph matches
forty ordered instructions through this actual route; synthetic host-byte fixtures do not qualify
a production host. This prerequisite covers accepted-workspace initial acquisition only. It does
not authorize global or above-root reads, watcher refresh, a model selector or production host
activation.

The private original host now wraps the actual builtin `ConfigInstructionPlugin` generation after
its original service capture, using one per-host Effect reference and the existing initialization
route. The original FSUtil closures capture the decorated dependency before acquisition; project
instruction discovery remains enabled while arbitrary project configuration and global instruction
discovery remain disabled. The scope permanently closes after the first callback, including for
inherited child fibers. The host copies decoded native bytes before wiping the canonical KSS3 frame.
The package builder copies the complete canonical codec and workspace deny-policy modules as fixed
sibling assets; it does not reimplement their formulas or accept an incoming module locator.
Before the first callback, only the accepted workspace's lexically and canonically contained
`realPath` metadata and the fixed private-state metadata are available. Fixed approved configuration
uses its already checked bytes; unexpected JSONC configuration is refused. Actual original host
acquisition matches one root instruction and preserves technical-unavailable output. Forty ancestor
instructions are separately qualified with a controlled Location/Project, not genuine VCS discovery.
Original Git discovery, the ready lifecycle and full native file/tool advertisement remain separate
requirements; this private prerequisite does not activate the production service.

The separately inactive original Read-parent transport also uses the existing authenticated tool
route. Closed begin/byte/stat/list/close packets require the existing admitted run's actual ready
state, observed exact session, current accepted root and captured native Read facet. They preserve
the canonical parent identity, replay/ordinal controls and single authority charge. Failed or
cancelled close validates that identity before aborting only its existing admission controller.
Completed close does not cancel unrelated work. Returned settlement joins actual physical work and
the same idempotent slot release, so response disconnection cannot free a still-running reader.
Private controls use genuine authority/Manager admission with hermetic endpoint and supervisor
readiness; they do not qualify the fixed service host as ready or activate its native advertisement.
The existing rejection operation records the closed `native-read-refused` reason without bodies.

A separately pinned, inactive `KSR3/KSS3` facet supplies bytes, ranges, descriptor metadata and
immediate directory entries to original native file consumers. Its collected output limit is
64 MiB, matching the pinned original process-backed Files contract; directory overflow is refused
without partial entries. Existing public text/snapshot limits and consumers retain their contracts.
The existing read/edit port owns its private primitive forwarding, with the same current producer,
authority guard and accepted-root pre/postflight. It records closed outcomes on the existing
`coding-runtime.workspace-read` line; response bytes and rejected content never enter evidence.
It also supplies a private additional currentness veto for physical IO admission. A lost binding
wipes returned bytes before refusal. This facet does not grant a model-visible tool or a native
host ingress. Actual original Read controls retain paging, directory, image/PDF and binary handling;
the original instruction service retains its own loading and deduplication. Initial/global
instruction discovery and complete native service
qualification remain separate requirements. Symlink content, hardlinks and cross-device content
are still refused; Windows native IO and Linux/Intel execution are not qualified by the macOS
controls. Those limits remain open native-parity work rather than permanent capability exclusions.
Private native IO now waits on the same eight physical slots used by public text reads. Its bounded
waiting capacity admits one complete supported ancestor-instruction load. Captured requests retain
their original path, range and cancellation signal; root, artifact and currentness are checked again
after waiting and immediately before physical IO. Cancellation removes waiters, while an admitted
slot remains held until the actual process settles. Public text reads retain their existing busy
result. Overflow is an explicit technical refusal, never partial instruction success.

An original Node service host has its own supplemental immutable artifact identity: final npm
payload and archive, fixed Node executable and bootstrap, dependency lock, license inventory,
SBOM and build-provenance evidence. Existing CLI archive approval neither approves nor selects
that host. The shared closed metadata contract distinguishes npm byte integrity from unavailable
upstream source-build attestation. Its inactive launch-shape producer admits only the fixed
bootstrap argument and rejects ambient Node loader or native-library injection. Ordinary CLI
approval checks retain their pre-build path; supplemental host checks require the compiled
canonical contract. These shape checks do not replace disk, platform, current-authority,
network or process-lifetime qualification and do not activate native tools.

The existing npm runtime builder also exposes a private, unapproved service-host candidate path.
It retains the approved CLI members and copies fixed original host assets, locked installed
dependencies and the artifact-owned Node distribution through the existing archive and tree owners.
Final npm extraction precedes payload attestation; npm-excluded metadata is reported explicitly.
The original npm SBOM root stays in its metadata exactly once, while the Node executable is added
with its measured digest. Installed alias identities retain their actual manifests and license
files. License-policy refusal remains in the private receipt and prevents production qualification;
the candidate has no publish configuration and does not change public runtime pins or selectors.

The inactive supplemental disk inspection matches declared canonical metadata to the server-owned
target supplement, then obtains the complete tree and six fixed Node/bootstrap/lock/SBOM/license/
provenance digests from one fresh stable pass through the existing attestation owner. Its immutable
receipt binds the inspected root and the platform captured before IO, and reports only
supplementary byte qualification. Mutation of an input platform during attestation cannot change
the later prepared-program target. It neither
measures the archive/count/source claims nor proves executable suitability, current authority or
point-of-launch freshness. Missing or unsafe files, cancellation and deadlines retain the owning
attestation errors and registered body-free log. The inactive fixed executable entry now serves the original public `createRoutes` graph through
the original Node HTTP/WebSocket server, preserving before-acquisition replacements. It accepts
one bounded immutable binding packet, publishes readiness after acquisition and closes its native
scope on stdin EOF. Its executable refuses a process cwd outside the packet's canonical workspace
before acquiring the original graph. Its database and freshness check use the existing launch
producer's `<stateRoot>/state/opencode.db` path. Original default session creation and its echo
retain that workspace Location. These entry controls do not establish current native filesystem
authority. The BFF separately checks the original created and echoed
session Location against the captured accepted workspace, and rechecks cancellation after each
await before proceeding to model readiness. Existing authenticated Fetch factory behavior remains
available. The existing Manager can privately prepare the distinct owned Node/bootstrap program,
freshly reattest it and write its single bounded packet through the owned stdin lifetime lease before
handshake. Unsupported or failed writes follow existing cleanup and recovery; a copied program or
receipt cannot replace the artifact owner's binding. Host readiness remains unqualified before the
ordinary CLI adapter can open, so this transport path does not activate the service. This prerequisite
still needs actual platform/process-lifetime controls, current native IO authority and fresh
final-payload qualification before production selection or launch. EOF closure alone does not prove
settlement of delegated effects.

The closed canonical startup packet now carries the same captured `direct` or `code-mode` profile
as the immutable run configuration. The shared contracts package owns that enum and the eleven
packet fields. A fixed generated data asset supplies those fields, profiles and the 16 KiB ceiling
to the native host and executable entry. Static imports select the existing fixed direct or Code
Mode factory; input cannot name a module, executable or source locator. Missing or arbitrary profiles refuse rather than silently choosing direct; valid mutable input
is captured before asynchronous work. A copied artifact receipt remains invalid. The existing factory algorithms
and default model projections remain unchanged. Actual original Tool/Plugin/Location acquisition
and provider request serialization qualify both selected mapped profiles, including the original
Code Mode inventory. That inventory includes two additional native items beyond the seventeen
managed handlers; these controls do not qualify those items or native workspace tools. They do
not activate the service or replace final packaged-byte/platform qualification.

Portable CLI discovery derives executable, license and SBOM digests from one fresh, bounded
content pass over stable file descriptors. Those evidence digests and the payload digest belong
to the same before/after tree snapshot; a separately read provenance file is not sufficient.
The existing locale-sorted payload digest remains byte-compatible, including complete paths that
collate equally. Only those ties require the historical directory-enumeration order. Launch uses
a separate fresh pass and never trusts cached discovery evidence for current disk contents.

Codex subscription traffic remains a distinct runtime/model source. Its egress uses Keiko's shared
enterprise proxy and custom-CA path, and any official authentication navigation target is validated
server-side against the closed official-origin policy before the browser may open it. Credentials
never enter browser intent, runtime events, or adapter launch configuration.

Content-bearing live prompt, response, model-reasoning (see the Issue #3878 amendment), diff, and
diagnostic events are transient, bounded, and access-controlled. Durable operational events and
evidence are a separate content-free projection; they carry only ids, digests, counts, booleans,
closed states/codes, and safe labels.

The authenticated live safe-activity tool projection also carries canonical per-call facts
(#3874): a completed read's workspace-relative path, returned-window bytes and whole-file line
count; the actual number of discovery entries returned; a closed edit refusal and the affected
relative path only when materialization identified it; and elapsed bridge service time. Service
time includes governed waits and excludes model generation. These facts come from the governed
producer, remain bounded by the existing aggregate feed limits, and survive native restatement
and immutable replay. Raw arguments/results, unknown refusal strings and unsafe paths are rejected.
Paths never enter Activity Log evidence, model-facing edit refusal replies or Coding History;
the existing tool-result operation records service duration through its standard duration field.

The owner-requested Coding History workflow (#3560) retains the visible user/assistant conversation
in the existing local UI conversation store. Native V2 history is validated and captured continuously
through the armed runtime's capture port, independently of the live display projection's TTL, turn
and byte limits. Replayed messages update the same source binding idempotently; growing responses
preserve their prefix and are chunked at the store's message bound. Display expiry cannot erase
already captured history. Task creation, run binding and the initial intent commit atomically;
a failed continuation preserves the existing task and messages. Dedicated relation tables associate
conversation, task workspace, operator and run. Generic chat routes exclude these records; dedicated
History routes authenticate the paired app session and scope access to the operator. Tool arguments,
results, hidden context, reasoning and authority credentials are not captured. Reads and model
context restoration remain bounded and report truncation explicitly. The existing body-free History
operation records capture source, counts and persistence failures; it never contains conversation text.
After a reload the Workbench rebuilds a settled run's timeline from this History (#3876 review): it
carries the newest messages that the safe-activity contract's bounds admit — per message, per turn,
per turn count and for the whole feed, each measured as the contract measures it — packed into as
many turns as they need, and the transcript above it shows every older message of the run whole, so
no message is shown in neither place. The rebuild reads the run's messages from the newest end and
only as far as the feed can still hold them: nothing older is stripped, dated or measured, it is
named for the transcript by position. Only a message cut to its own bound and the older messages
Coding History itself cut make the activity read as truncated. The body-free
`client.coding-run.restored` line records the counts of this split (ADR-0173).

Delivery approval, one rule for D3 and D4. In `governed-assist` and `supervised-coding`, commit,
push and pull-request create/update each require their own action-bound, one-use human approval in
addition to runtime authority; no connector scope or earlier start confirmation pre-approves them.
`autonomous-delivery` is the one mode whose accepted Authority Envelope authorizes those three
actions inside the envelope without a per-action approval (ADR-0129 Full access, ADR-0138 D2): the
policy decides `allowed`, every effect still runs through the governed delivery tools, and D3's
delivery-truth rule decides whether the run delivered. Merge and Authority Envelope widening
require their own human approval in every mode (ADR-0087).

### D5 — Process-tree ownership and platform qualification are fail-closed invariants

The BFF process supervisor owns the complete spawned runtime process tree from the first spawn until
it has observed and recorded that every descendant is reaped. Stop, takeover, runtime crash, Keiko
shutdown, and product update first revoke the run's Authority Envelope and block new delegations,
then terminate the complete tree. A run reaches a terminal/reusable slot only after the supervisor
proves tree exit. If complete exit cannot be proven, state becomes `recovery-required`; the active-run
slot remains occupied and no replacement run may start until reconciliation proves reap.

The `starting` state admits the same `stopping` path as an established run. Its server-owned
startup cancellation signal covers asynchronous preparation, handshake and initial context loading;
stop, takeover and shutdown abort it. Immediately before spawning, the manager checks cancellation
again, so late preparation cannot create a tree after a successful stop. A delayed start result
waits for the interruption's teardown result and never dispatches the initial task or replaces its
terminal state. An unproven teardown or a late live host remains `recovery-required`; cancellation
does not substitute for process-tree exit proof (F25, #3873).

Launch attestation uses asynchronous filesystem IO and bounded cooperative yields, so startup
cancellation can run while a large immutable payload is checked. The existing startup deadline,
tree and file bounds still apply. Immediately after that await and before process creation, the
manager verifies the same active start, current workspace, cancellation and accepted authority.
This check neither renews nor widens authority. Discovery retains its synchronous boundary and
does not acquire a new launch deadline. Historical directory enumeration can allocate its native
entry array before a concurrent tree growth is refused; this change makes no stronger allocation
or startup-latency guarantee for that existing owner.

The pinned OpenCode V2 Darwin application-sandbox backend also uses the native `serve --stdio`
stdin-EOF lifetime lease. The verified V2 preparation producer and the existing process backend
must both support it before the manager selects that fixed launch form. The supervisor refuses an
unsupported lease marker, and the backend refuses a missing or closed writable pipe before it
accepts tree ownership. Keiko retains the pipe for the complete runtime lifetime; handshake,
tool dispatch and adapter disposal never end it. OpenCode keeps its authenticated HTTP service
and closes its native server scope when the owner's pipe reaches EOF. Readiness accepts only the
native closed loopback URL record or the existing ordinary-serve line. The existing body-free
confinement-spawn record identifies the selected lifetime form. This does not extend authority,
replace explicit tree reap, or qualify the sealed helper and other platforms by inference.

An acknowledged recovery row remains visible until a replacement starts, but no longer blocks
workspace selection when the runtime manager reports `stopped`. Workspace activation uses that
specific predicate rather than treating every retained recovery row as a running process. The
checks before body parsing and immediately before checkout mutation remain; an unacknowledged row
or a host in any other state still blocks selection. History and shutdown keep the broader live-row
predicate, and acknowledgement never turns an unproven host into a stopped one.

Supported platform names are not sufficient evidence that confinement exists. Runtime availability
uses this release-qualified matrix:

| Platform | Availability requirement | Prohibited assumption |
| --- | --- | --- |
| Linux x64 | The exact release payload carries an offline-verifiable GitHub-OIDC Sigstore qualification receipt for `linux-namespace-gateway`, and the host can create the qualified user/network namespace at launch. | A supported kernel name, source-only namespace test, or network namespace without the anonymous gateway bridge is not release qualification. |
| Windows x64 | The release-qualified Windows confinement and process-tree termination backend passes its qualification evidence. | Killing only the immediate parent process is not descendant termination. |
| macOS arm64 | The release-qualified macOS arm64 confinement and process-tree termination backend passes its qualification evidence. | Shell or inherited session/process-group membership is not proof of containment or descendant ownership. |
| macOS x64 | The release-qualified macOS x64 confinement and process-tree termination backend passes its qualification evidence. | Shell or inherited session/process-group membership is not proof of containment or descendant ownership. |

An unsupported platform, missing backend, unenforceable confinement primitive, stale qualification,
or failed process-tree termination proof makes the runtime source `unavailable` before spawn. Keiko
must not attempt a best-effort launch, downgrade to parent-only termination, or infer support from a
nearby architecture or operating-system family.

Issue #2251 implements the confinement, supervision, revocation-before-termination, and observed-reap
enforcement defined here. Issue #2258 release-qualifies each platform/backend pair and supplies the
evidence that permits availability. This ADR owns the invariant; those issues may implement and prove
it but may not weaken or reinterpret it.

## Reconciliation with accepted decisions

| Existing decision | Treatment in this ADR |
| --- | --- |
| ADR-0124 | Amended only where it allowed the Authority Envelope to exist without a server-owned minting aggregate. The three modes, runtime/model-source separation, content-free evidence, and delivery split are preserved. |
| ADR-0125 | Preserved. The tri-state matrix, V1 editor wire compatibility, existing authority registry, cumulative budgets, and immediate pre-action re-resolution remain authoritative. One-use applies to mint confirmations and action approvals, not the retained run envelope. Runtime authority composes this registry. |
| ADR-0088 through ADR-0093 | Preserved and reused. `WorkspaceInstance`, the singleton active binding, lifecycle health, containment, locks, drift, and recovery remain the task/workspace authority; runtime code does not create another workspace registry. |
| ADR-0059 through ADR-0062 | Preserved. Editor actions retain opaque authority references, the live bridge/session boundary, bounded queueing, stricter-wins governance, and content-free audit. Runtime contracts do not create another editor transport. |
| ADR-0030 and ADR-0048 | Preserved. Durable operational records are content-free and confidentiality/retention controls remain in force; raw task/model/process content is transient and separate. |
| ADR-0121 | Preserved. Portable payload staging, provenance, update verification, activation policy, and the no-rollback/no-downgrade rule remain independent of runtime authority; this ADR does not install, update, locate, or launch a binary. |
| ADR-0080 through ADR-0086 | Preserved. Branch binding does not grant Git mutation, publish, pull-request, or merge authority; those operations still route through their governed preview/approval gateways. |
| ADR-0022, ADR-0034, and ADR-0046 | Preserved. Connector scope in an envelope is an upper bound, not execution authority; connector egress, privacy, and credential custody stay with existing boundaries. |
| ADR-0061 | Preserved. Browser code remains capability-bound and has no filesystem, shell, process, Git, connector, provider, or policy-minting authority. |

## Consequences

- Child runtime work can implement protocol adapters against a stable Keiko-owned port without
  exposing adapter or process details to the browser.
- Existing incomplete live runs are not migrated; operators start a new governed run.
- The initial authority service is intentionally in-memory and single-run. Recovery persistence,
  transport/backpressure, and real-binary execution belong to ordered corrective children and cannot
  be inferred from these contracts. Process-tree ownership and revocation-before-termination are
  normative here; #2251 implements them and #2258 qualifies the platform backends before activation.
- No production traffic was migrated by Issue #2252; Issue #2256 owned route replacement and
  orchestrator wiring because this issue expressly forbade browser-route implementation. Issue #2958
  completed that removal by deleting the unmounted caller-authored authority scaffolding, so no
  second, unreachable delivery front door remains beside the server-owned path. No primitive was
  relocated out of it: the one-use proof store, envelope digest, branch and scope admission, ceiling
  clamp, and operator stop all already had live owners, and the boundary assertions its tests
  carried moved onto `gitDelivery/runBoundAuthority.test.ts`.

## Alternatives considered

### Confirm a browser-authored envelope

Rejected. Validation can prove shape, but cannot make caller-selected roots, scopes, ceilings, or
budgets authoritative.

### Put adapter launch configuration in the shared request

Rejected. It would make browser-safe contracts a process-authority and credential transport.

### Add a coding-specific workspace or editor registry

Rejected. Existing task-workspace and editor-agent authorities already own those invariants.

## Amendment — Issue #2951 makes egress qualification part of runtime qualification (2026-09-12)

Issue [#2951](https://github.com/oscharko-dev/Keiko/issues/2951) corrects D4–D5: process-tree
ownership is necessary but is not proof of network confinement. Every coding-runtime launch now
requires both the existing owned-tree qualification and a policy-specific OS egress decision before
the spawn boundary is crossed.

### D6 — Runtime/model source determines the exact egress profile

`keiko-sidecar` with `keiko-model-gateway` is loopback-only: it may reach the authenticated Keiko
gateway/BFF and never the public network. `codex-cli-adapter` with
`chatgpt-codex-subscription-profile` retains its distinct reviewed enterprise-proxy or explicitly
approved direct-egress policy; it must not be redirected through a nonexistent gateway proxy. A
source/profile mismatch is invalid rather than coerced to a nearby policy.

Environment variables can configure a reviewed proxy, CA identity, or direct-egress decision, but
they are not enforcement. A long-lived runtime is available only when a release-qualified OS backend
can enforce that exact policy and return launch-bound attestation. Missing backend, stale or invalid
policy receipt, wrapper failure, or attestation mismatch prevents spawn. Autonomous delivery cannot
continue without this boundary; less-authoritative modes may expose only their existing no-sidecar or
read-only degraded behavior and never an unsandboxed runtime.

### D7 — Network and tree lifecycles are one supervised lifecycle

The wrapper is the root executable handed to the same native/dev owned-tree supervisor. Stop,
takeover, signal, crash, restart, reconciliation, and cleanup therefore apply to the sandbox wrapper
and all of its descendants; there is no separately owned sidecar outside the tree. Successful launch
returns only content-free attestation binding the backend/platform, runtime/model sources, Authority
Envelope digest, reviewed-egress receipt, and policy/proxy/CA digests.

## Amendment — Issue #3878 shows the model's reasoning in the live timeline (2026-10-06)

Owner decision (2026-10-06): the Coding Workbench timeline shows the model's own reasoning. Until
now the timeline stated that it "never exposes private reasoning", and the model gateway discarded
the reasoning that providers return beside the answer (LiteLLM's `reasoning_content`).

### D8 — Model reasoning is transient live content, labelled, opt-out, and never evidence

- **Default on, operator opt-out.** A coding turn's gateway call, which carries the explicit
  `reasoningDelivery: "forward"` that only the coding sidecar route sets, forwards the model's
  reasoning unless the gateway configuration sets `codingReasoningDisplay: "off"`; with the switch off
  the gateway still parses the reasoning and discards it. Every other surface always discards it,
  also one that borrows the `coding-workbench` latency profile for its timeout floors (ADR-0003,
  #3873 F23).
- **Never resent upstream.** The runtime records the forwarded reasoning in its history and sends it
  back with later requests. The sidecar drops it there: the reasoning fields of prior assistant
  messages never reach the gateway request, and an assistant message that carries nothing but
  reasoning (no answer text, no tool call) is dropped and counted
  (`droppedReasoningMessageCount` on `coding-sidecar.gateway.request-validated`), so a failed turn's
  reasoning does not grow the prompt of the attempts that follow it (#3873 F23).
- **Shown as what it is.** The sidecar hands reasoning to the managed runtime as
  `reasoning_content`; the runtime records it as a reasoning part, and the live safe-activity
  projection carries it beside its assistant message, never inside the answer. The timeline shows
  it as a collapsible "Model reasoning" block labelled as unverified model reasoning, collapsed
  until the reader opens it — also while its turn streams. The session stream is a `role="log"`,
  whose additions a screen reader announces, so up to 8 KiB of unverified reasoning per message
  must not crowd out the answer: a collapsed block exposes only its summary, and an opened block
  keeps its streaming text out of the announcement with a nested `aria-live="off"` (#3873 review;
  an earlier text opened the block while its turn streamed). The boundary copy says what is shown
  instead of promising that reasoning is never exposed.
- **It streams from the runtime's delta events, not from its history.** The pinned OpenCode 2.0.10
  persists a streamed text or reasoning part only twice: empty when its block starts and complete
  when the block ends, which for the OpenAI-compatible protocol is when the whole response finishes.
  The words in between travel only as ephemeral `session.text.delta` and `session.reasoning.delta`
  events; each names its assistant message and an ordinal numbering the parts of its kind in that
  message from zero, and no history read ever returns them. A timeline built from history alone
  would show the reasoning and the answer together, complete, when the response ends (PR #3876
  review; measured against the pinned runtime with a slowly streaming provider). The history
  projection therefore reads each text and reasoning part through a bounded live overlay
  (`opencodeV2LiveText.ts`), fed by every event of the run's session as it arrives and before sync
  hints are coalesced. A part is tracked from its `started` event and grows by its deltas in order;
  the history's n-th part of that kind is the part with ordinal n. A delta for a part that was never
  seen starting, for a part the replaced event stream had been feeding, for a part that reached its
  bound, or that is malformed extends nothing and is counted: a gap in the middle of a text would
  show words the model never wrote in that order, so such a part shows what it has until the history
  shows it complete. Text is bounded by the history's own part bound (64 KiB), reasoning by the
  projection bound, cut on a whole character exactly where the projection cuts the finished part, so
  the live text is always a prefix of what the history later shows; a half surrogate pair waits for
  its other half. When the history shows the part complete and extends what streamed, the persisted
  text takes over and the live text is spent, so nothing is appended twice; a complete text that does
  not extend the shown text keeps the shown text and is counted, because the timeline cannot take
  words back. Coding History records only the persisted part, never the live text, so a turn cut
  short leaves no partial answer and a streaming turn does not rewrite the stored message on every
  delta. A history that grows by suffix on its own is shown as before.
- **Reads are coalesced, and the log says by how much.** A live turn can emit an event for every
  streamed token, and each sync hint costs one history read, so the pump folds the plain hints that
  pile up while a read runs into one, and a control hint's read covers the plain hints queued before
  it (control hints are never dropped and keep their order). Production spaces ordinary history
  reads by at least 100 ms using a monotonic clock, so a fast response cannot force another full
  read for each streamed delta. Control hints, source failure and source end flush immediately;
  every live delta is still observed before coalescing. Every event is therefore a hint
  delivered or an event merged, apart from the hints still queued when the run stops;
  `mergedEventCount` on `coding-runtime.history-projection` is the number merged since the previous
  line, so a timeline that lags or skips an update is explained by how many events one read stood
  for (PR #3876 review).
- **Bounded, and the first content to go.** Reasoning keeps to half of a message's live byte
  budget, yields room to the answer within its message, and is the first content evicted under turn
  or feed byte pressure; the newest message keeps the reasoning that may still be streaming.
- **Never evidence.** D4's durable rule is unchanged: reasoning never enters Coding History,
  evidence, a support export or the Activity Log. Durable lines record only counts — reasoning
  events, bytes, provider-reported reasoning tokens, frames and a closed disposition — never text.
  The live overlay is counted the same way: `coding-runtime.history-projection` carries
  `liveDeltaCount` (deltas that grew a live part), `liveDroppedCount` (deltas that extended
  nothing) and `liveDivergedCount` (parts whose complete text did not extend what was shown) since
  the previous line, and a pass that changed nothing writes no line, so its counts wait for the next
  one.

## Amendment — the run status names a model gateway that is being retried (2026-10-07)

Review of PR #3876 (F11/F21 of the live qualification, #3873): during a provider outage the coding
sidecar gateway retries for its outage window (ADR-0003, default ten minutes), the turn waits
silently, and the run status read "Waiting for the model" for the whole window — the same words as a
slow generation. A second thread of the same review found the same silence before a call's first
attempt, where it is the circuit breaker or a provider cooldown, not a failed attempt, that holds
the call. A third found that the fact was published once per call although the Workbench reads the
newest frame of the replay: a later frame hid the outage while it went on, a call the run cancelled
left the fact standing while the next call generated, and a publication the replay refused was never
repeated.

### D9 — The sidecar route publishes three body-free gateway facts to the run's event replay

- **Where they come from.** `GatewayCallRequest.retryObserver` (ADR-0003) hears a call's outage: a
  failure that says the provider is unavailable (a timeout, a refused connection, a retryable 5xx, a
  rate limit) was met with a scheduled retry, the call's admission began to wait for the circuit
  breaker (open, or its half-open probe slot saturated) or for a cooldown the provider announced, or
  a call it heard settled. The coding sidecar route hands every model call such an observer. The
  first retry or wait of a call is published as `model-gateway-retrying`; the answer that ends the
  outage as `model-gateway-recovered`. The wait matters on its own because a call's first attempt
  follows no failed attempt: a turn the runtime retries after an earlier call outlasted the window,
  or a run whose first turn starts during an outage, queues behind the open breaker or another
  run's probe with no retry to announce. A steered repair or a schema correction answers the
  model's own output, so it is never announced as a retry. A wait that cannot fit the call's window
  never begins and is not announced; that refusal is the turn failure alone.
- **One frame per outage while it is the newest, and again when it is not.** The Workbench reads
  the newest frame of the run (below), so the fact stays one frame per outage only while it is that
  frame. A later frame of the run (a pause or resume, a mode change, a research revoke, a tool
  event) ends the phase on the client while the call keeps retrying; the call's next retry or wait
  then publishes `model-gateway-retrying` again, and the route asks the replay
  (`CodingRuntimeEventHub.modelGatewayRetrying`) rather than remembering its own last publication.
  A publication the replay refused (`published=false`) does not count as published: the call's next
  notice tries again, and an answer that follows only refused facts publishes no recovery, because
  there is nothing on the replay to recover from.
- **A call that ends without an answer.** A call that fails for good (its window refused the wait,
  or it exhausted its retries) publishes no closing fact of its own: its turn-failure frame (D3)
  follows and is the newest frame. A call the run cancels while it is retried or held (the client
  went away, the transport was cut, the route deadline ran out) ends with neither an answer nor a
  turn-failure frame, so `model-gateway-recovered`, which says a call was answered, would be false
  and silence would leave the fact standing while the next call generates. The route therefore
  closes it: when the call ends, after its answer or failure frame has been settled, a call whose
  fact is still the newest frame of the run publishes `model-gateway-retry-stopped`. The route
  decides this when the call ends, not when the observer hears `settled failed`, because only then
  is it known whether a failure frame followed. A run that is no longer live (stopping or settled)
  has no status to show, so nothing is published for it and the gateway's own lines are the record.
- **What they are.** Three SSE-only runtime event kinds of their own
  (`CodingWorkbenchGatewayEventKind`), not adapter events: the runtime never produces them. A frame
  carries no count, text, identifier, failure code, outcome or trust marker, and the contract
  validator refuses any of those on it. They are ordinary, evictable replay frames: never critical,
  never the run's last model-call failure, so a retry is no failure and cannot demote or crowd out a
  real turn failure.
- **What the Workbench does with them.** The newest event the Workbench holds for the run decides:
  while it is `model-gateway-retrying`, the run status names the phase "Model gateway unavailable,
  retrying" instead of "Waiting for the model". The recovery fact, the retry-stopped fact ("Model
  gateway retry stopped" in the run details) and any later event of the run (a failed turn, a
  pause, a settlement) end the phase, so a lost closing frame cannot leave the status claiming an
  outage for good. A decision the run waits for still takes precedence. This is the one phase that
  joins the status sentence itself, which is the polite, atomic live region (`role="status"`): a
  screen reader announces "Running. Revision 4. Model gateway unavailable, retrying." where it had
  read only "Running" for the whole outage, and the status line shows the phase once, not a second
  time beside the sentence. The other phases (waiting for the model, running a tool, running a
  verifier, waiting for a decision) change with every step, so they stay visible beside the
  sentence and are not announced.
- **Evidence.** Each publication, refused or not, leaves one body-free
  `coding-sidecar.gateway.retry-surfaced` line under the run's correlation: the run revision and
  state, the fact (`retrying`, `recovered` or `retry-stopped`), what a `retrying` fact followed —
  the failed provider `attempt` of a retry, or the `waitReason` that held the call's admission
  (`provider-cooldown`, `circuit-cooldown` or `probe-saturated`, the reason of the
  `gateway.circuit.wait` line it joins on) — with the retry policy the call ran under, and whether
  the replay took it (`published`, `publicationReason`). A refused publication is a warning. The
  gateway's own `gateway.retry.scheduled` and `gateway.circuit.wait` lines remain the record of
  every individual retry and wait.
- **Two attempt numbers, on purpose.** The `attempt` of a `retry-surfaced` line (and of the
  observer's notice it comes from) counts the failed provider attempt the retry follows, from 1; a
  steered repair is not a provider attempt and is not counted. The `attempt` of the
  `gateway.retry.scheduled` line of the same retry counts every attempt of the call, the repair
  included. After an exhausted answer that was repaired and then met an unavailable provider, the
  repair is scheduled as attempt 1 and never announced, and the retry after the 503 is scheduled as
  attempt 2 and surfaced as the retry that follows provider attempt 1. Both lines carry the turn
  request's correlation id, so the difference is read, not guessed; the numbering is pinned in
  `gateway.coding-outage.test.ts` and, through the route, in `coding-sidecar-gateway.test.ts`.

## Amendment — the Coding Workbench runs the native OpenCode service (2026-10-23, #3897)

Owner decision, 2026-10-23: the Coding Workbench offers the original OpenCode service as it runs
standalone. Keiko is the foundation around it, not a replacement for its parts. D4's sentence
"production currently continues to deny native workspace effect tools" is superseded by D10 below.

### D10 — The native tool profile binds the autonomy mode through supported hooks

- **One profile selects it.** `productionOpenCodeToolProfile()` in `deps.ts` is the server-owned
  selection of the `native` profile on macOS (`OPENCODE_TOOL_PROFILES`; Linux and Windows map to
  `direct` until a native boundary is qualified there); no request field can select a profile. The mapped `direct` and `code-mode` profiles remain available to tests and to an
  explicit server selection, and the governed `keiko_*` catalog, the tool facade and Chat
  repository search stay in place for the surfaces that use them.
- **The runtime keeps its own tools, agents and configuration.** The launch configuration of the
  native profile (`opencodeLaunchProfile.ts`) names no ordinary action: it denies only the
  mode-independent `external_directory` escape (admitting the run's own plan directory), keeps
  `update` and `share` off, keeps the single `keiko-runtime` provider behind the Model Gateway, and
  enables native snapshots. The producer appends configured rules after each built-in agent's own
  rules and the last match wins, so any configured rule naming an ordinary action would replace an
  agent's own denial: the earlier blanket `allow` (and a blanket `ask`) let the Plan agent write
  project files in Full access (#3897 review). Without it every built-in agent keeps the producer's
  rules (https://opencode.ai/v2/docs/agents/#builtins): Plan cannot edit project files and may
  write only its plan directory, Explore keeps its read-only `*` denial, General cannot launch
  subagents. The policy hook then narrows whatever an agent's rules allow or ask; an agent's own
  `deny` is final before the hook. Agent selection is therefore independent of the Keiko mode:
  Full access is not Build, and Plan stays read-only in every mode. The real-binary suite
  (`opencodeNativeProjectBoundary.real.test.ts`) pins it with the production plugin and a facade
  that allows everything: Plan's project write leaves the file unchanged without asking the hook,
  its plan-file write and Build's write go through.
- **A native run readies only with its governing plugins active.** No configured rule stands in for
  the policy hook, so the fail-closed property lives in readiness: after the protocol digest the
  adapter enters the `policy-plugin` phase, which polls the producer's admitted `GET /api/plugin`
  (`plugin.list`) for at most ten seconds until `keiko.native-policy`, `keiko.native-context` and
  `keiko.native-delivery` are `active` from Keiko's own generated files
  (`opencodeNativePluginReadiness.ts`). A failed or
  unparsable plugin, a required id claimed from another file or twice, or a plugin still missing
  when the bound runs out refuses the start (`runtime-profile-open`) before any session or prompt.
  The real-binary suite shows an absent and an unparsable policy plugin never read as ready and
  the production launch does. A configured `deny` is applied before the hook and cannot be raised
  by it (an `external_directory` read is refused with the facade never asked). Repository text
  decides nothing about authority: the policy hook runs after OpenCode's own rule evaluation.
- **Code Mode stays available (owner decision, 2026-10-23); no rule names its `execute` action.**
  The native profile offers the producer's `execute` tool with the ordinary tools, and its catalog
  lists exactly the eight `tools.opencode.*` management tools (session rename and move, worktree
  create, list and remove, model search, MCP resource listing and reading); `read`, `edit`,
  `shell` and `write` are not callable inside it. Facts of the pinned producer that the policy
  plugin's governance of Code Mode relies on, each pinned by the same real-binary suite through a
  test-only probe plugin: `tool.hook("execute.before")` fires for the `execute` call (input
  `{ code }`) and for every nested call, under the effective tool name (`opencode_worktree_create`)
  and the nested input, with the outer call's id; the event has no verdict field, a throw blocks
  the call (a nested throw reaches the script as a catchable error whose message is the model's
  result, a throw for `execute` ends the script before it starts with the producer's error
  envelope), and the call's `input` can be replaced while its `tool` cannot be renamed.
  `permission.hook("evaluate")` fires only for the nested tools that assert a permission:
  `opencode_read_mcp_resource`, `opencode_list_mcp_resources` (whose producer default is already
  `allow`) and `worktree_remove` (as `edit` on the worktree directory); worktree creation, session
  moves and renames, model search and the worktree listing assert nothing, and the `execute` call
  itself evaluates no permission. The generated plugin therefore decides the Code Mode program
  itself through `tool.hook("execute.before")`: the policy classifies `execute` as command
  execution, so Ask for approval and Supervised workspace ask before a program starts and a
  refusal blocks it before it runs. The human reviews the program itself: its text, split at line
  breaks into the bounded review resources (64 × 2,048 characters; a longer line is refused as too
  large to review), is the ask's resource and is never logged. `fetch` is a Code Mode primitive that
  neither hook sees inside an admitted program: the kernel egress rule governs it (loopback below
  Full access).
- **An unoffered native tool name is the producer's to answer.** The gateway binds a native call
  by name only and grants nothing (ADR-0175 D2). A model that names a tool the request did not
  offer (a hallucinated `bash`, say) reaches OpenCode, which answers with its own unavailable-tool
  result and continues the turn, as standalone; refusing it at the gateway ended the whole turn.
  `gateway.tool-catalog.native-passthrough` counts such calls as `unofferedCount`.
- **Narrowing cannot outlive the launch egress.** Seatbelt binds a native tree's egress when it
  execs (`openCodeNativeEgress`). A tree launched in Full access keeps inherited egress, so a
  resume that narrows it below Full access is refused (`authority-resolution-failed`, recorded on
  `coding-runtime.native-narrowing.refused`) instead of acknowledged while a shell or a Code Mode
  `fetch` keeps Internet access; narrowing between the modes below Full access applies in place.
  Continuing the same OpenCode session under a relaunched, narrower tree is not implemented.
- **Repository configuration is data until the operator admits its executable effects (#3903).**
  A first increment loaded the repository's `opencode.json` and `.opencode/` directory like
  standalone. That is retired. The pinned 2.1.4 producer discovers a project's `opencode.json`,
  `.opencode/` agents, commands, skills and `plugins/` modules (and any module an `opencode.json`
  `plugins` entry names) as one layer, imports a plugin module's top-level code and `setup` before
  any permission is evaluated, and merges a project `providers`/`model` entry above the private
  discovery file. A permission hook cannot govern a module's load, and a repository could move
  `providers.keiko-runtime.settings.baseURL` off the Model Gateway. The producer offers no
  per-item admission and its plugin API has no late `config` hook, so the native launch profile
  sets `OPENCODE_DISABLE_PROJECT_CONFIG=true` for every tool profile: nothing under the workspace
  is a configuration layer, runs as a plugin, or selects a provider, model, credential or
  permission. The restriction is explicit and documented: project `opencode.json`, `.opencode/`
  agents, commands, skills and plugins, nested `AGENTS.md` discovery, `.claude/` and `.agents/`
  do not load until #3903 admits individual items through the existing workspace trust and
  authority admission (an accepted plugin must then stay inside the live Authority Envelope and
  must not be able to replace the governing `keiko.native-policy` hook). The workspace-root
  `AGENTS.md` still reaches the model as Keiko's own bounded, nonce-framed, untrusted initial
  context (ADR-0137 D1). Keiko's generated plugins load from the private discovery directory,
  which the switch does not touch.
- **The server-owned binding rides the highest layer.** The profile also passes the single
  provider, model, `default_agent`, `update`/`share` switches and the mode-independent permission
  floor as `OPENCODE_CONFIG_CONTENT`, a secret-free subset of the private file that holds only
  `{env:…}` placeholders (the gateway address and capability stay in the child environment). The
  producer merges that virtual document after the private file and after every discovered project
  document, so it stays the last word if a project layer is ever admitted, including across a
  configuration reload. Model egress below the process boundary remains the Seatbelt/namespace
  profile's concern (D4); this binding is the configuration-level enforcement. Both properties are
  proven against the staged original executable under the real native Seatbelt wrapper
  (`opencodeNativeProjectBoundary.real.test.ts`): a repository that writes a canary from a file
  plugin, a directory plugin and a configured plugin at module load, and that points the provider
  at a separate loopback listener, produces no canary and no request to that listener, the Model
  Gateway receives every model request with its own credential and model, and a control with the
  project layer switched on shows the same plugins executing yet the route still bound.
- **The operator selects the primary agent through the session, never the launch.**
  `default_agent` stays `build`. An optional `agent` (`build` or `plan`, the closed
  `CODING_WORKBENCH_AGENTS` vocabulary) travels on a start or a follow-up; the composition issues
  `session.switchAgent` (`POST /api/session/{sessionID}/agent`, admitted in the pinned protocol
  surface) once, before the prompt, only when the agent differs from the run's current one, and a
  refused switch fails the submission instead of running the prompt under another agent. `plan` is
  OpenCode's own read-only agent (edits denied except its plan file), so it is offered on the
  native profile only: the mapped profiles route every tool through Keiko's facade, which does not
  apply that policy, and a Codex run has no agent concept. Both refuse `plan` as `invalid-intent`,
  a start before any run exists and a follow-up before the adapter is reached. The switch only
  narrows what a turn may do; the Authority Envelope, the mode and the policy hook below decide
  every action as before. Each effective switch is recorded body-free as
  `coding-runtime.agent.selected` (run, new and previous agent). The browser learns what it may
  offer from the readiness read it already performs before a start: `selectableAgents` (always
  carrying `build`) is computed from the composed tool profile through `openCodeSelectableAgents`,
  and the contract validator refuses an absent, duplicated, unknown or `build`-less list. The
  composer shows a Build | Plan switch only where that list offers `plan`, keeps it operable
  between turns (idle, paused) and fixed while a turn runs, sends the selection with every start,
  retry and follow-up (`build` included, so a follow-up can switch back), and names the plan agent
  in the run status line and information panel.
- **The prompt takes a message while a turn runs and the files its text references.** A follow-up
  may carry `delivery` (`steer` or `queue`, the closed `CODING_WORKBENCH_PROMPT_DELIVERIES`
  vocabulary) and `references` (at most 16 `{ path }` entries relative to the run's workspace root;
  the browser never sends an absolute path or a URI). A delivery joins the turn in flight, so it is
  admitted only for a `running` run whose adapter still tracks a turn, never names an agent, and
  starts, replaces and settles nothing: the turn keeps its own settlement, and an accepted message
  advances the revision with `task-submitted` so the next one is admitted. It passes the same
  dispatcher admission as any delegation (live authority revalidated, the revision consumed once, a
  single-use request id). The pinned 2.1.4 behaviour is proven against the original executable
  (`opencodeNativePromptInputs.real.test.ts`): `steer` reaches the model with the running turn's
  next step and `queue` after its final answer, both inside one execution, so the one settlement
  Keiko waits for covers them; a delivery sent to an idle session starts an execution nothing in
  Keiko would settle, which is why admission requires a turn in flight. Both inputs are offered by
  the native profile only (`openCodePromptInputs`, reported as `promptInputs` in the readiness
  read) and refused as `invalid-intent` elsewhere and for a Codex run, exactly like a `plan`
  request. A reference must resolve, through the descriptor-bound workspace read, to a plain UTF-8
  text file inside the run's canonical workspace root: no `..`, no symbolic link (the real path is
  judged again), no hard link, no sensitive path (`isDenied`, the list the kernel boundary shares),
  at most 64 KiB per file, 192 KiB per prompt and 1 MiB per run (the runtime embeds the bytes in
  the session history that Keiko reads back whole). The first violation refuses the whole prompt
  before anything is sent. The attachment is the runtime's `files` entry (the `file://` URI of the
  real path and the file name); the typed text stays the visible message and the file content stays
  out of the timeline, Coding History and logs. Evidence is the body-free
  `coding-runtime.prompt-inputs.settled` line: the run, `accepted` or `refused`, the closed
  delivery, the reference count, and the attached bytes or the closed refusal reason, never a
  path, name or text. The composer offers Send now (Enter) and Queue (Ctrl or Cmd+Enter) while a
  turn runs and the `@` picker (the Files search over the run's workspace, no second index) while
  a run runs or is paused. A start carries no references yet: the workspace they name does not
  exist before the run is minted.
- **Every evaluated action asks the server-owned policy.** The generated `keiko.native-policy`
  plugin registers OpenCode's supported `permission.evaluate` hook and asks the tool facade
  (`native-policy` action) for the final effect of each evaluated action. `opencodeNativePolicy.ts`
  classifies the action (read, edit, vetted or unvetted shell command, internet, Code Mode) onto
  the ADR-0138 D2 matrix for the run's mode, applies the mode-independent hard denials (workspace
  escape, denied sensitive paths, Keiko-owned Git delivery through the shell, unclassified actions)
  and, where the matrix says approval-required, puts the action to the human through the existing
  approval lane; the human's decision becomes the hook's `allow` or `deny`, and a denied call ends
  with the same guidance as a declined governed ask (ADR-0124 D6). A missing, failed or oversized
  policy answer denies the action. Reads and planning are allowed in every mode (ADR-0124 D1).
- **What the human sees.** A native ask carries a closed label (`native-shell`, `native-edit`,
  `native-egress`, `native-execute`) on the permission request and the agent's own command line,
  paths or address on the authenticated approval-review channel (`nativeAction`), never on the
  runtime snapshot, the SSE projection or the Activity Log.
- **The shell sees no Keiko secret.** The same plugin registers `shell.create.before` and removes
  the server password and every `KEIKO_*` binding from the environment of every shell the agent
  starts.
- **The Model Gateway forwards the native tool contract as data.** A native request carries the
  runtime's own advertised tools; the route admits a bounded advertisement (at most 128 admissible
  names, 64 KiB per schema, 512 KiB in all; `opencodeNativeTools.ts`) and mints a `native`
  advertisement (`GatewayNativeToolAdvertisement`) the bridge forwards verbatim and binds back by
  name only. Nothing in it registers a handler, effect or authority in Keiko (ADR-0175 D2); this
  holds for Keiko's own delivery tools below too, which arrive as definitions like any other. The
  edit, write and patch tools are exact-content tools: their arguments reach the runtime byte for
  byte (#4009).
- **A native run hands a read image to a model that declares image input (#3897, S14).** The
  native provider model declares `input: ["text", "image"]` only when the admitted model's
  configuration declares `supportsImageInput`; one projection (`runMetadata.supportsImageInput`)
  feeds both the launch profile (`OpenCodeContextGeometry.imageInput`, read by the native profile
  alone) and the route. The mapped profiles and a text-only model keep the text-only declaration,
  and OpenCode then tells the model it cannot see images, as standalone. The runtime sends a read
  image as a user message holding one `image_url` part with a base64 data URL.
  `coding-sidecar-image-parts.ts` admits it into the existing `ChatMessage.contentParts`, so the
  Model Gateway's provider projection, image token allowance and `gateway.prompt.admission`
  evidence apply unchanged, only for the native profile and a declaring model, only as an inline
  data URL of an allowed image type (the Chat attachment policy: SVG refused) of at most
  `MAX_ATTACHMENT_BYTES` (the 4 MiB request body bounds a request first), at most 16 parts per
  request, on a user message. A remote or file reference stays an unsupported content part; every
  other refusal is one of five closed `coding-sidecar.gateway.rejected` reasons
  (`image-part-invalid`, `image-mime-unsupported`, `image-part-too-large`, `image-count-exceeded`,
  `image-input-unsupported`). Evidence is counts only (`imageCount` on
  `coding-sidecar.gateway.request-validated`, `imageInputDeclared` on the native
  `coding-runtime.readiness.phase` line); no image bytes, path or URL enter a log. Authority is
  unchanged: the read stays the policy-governed, kernel-contained native `read`. The original
  executable shows it (`opencodeNativeImageInput.real.test.ts`): a scripted `read` of a PNG puts
  one image part, byte for byte, in the next provider request and in the request the production
  route hands the gateway; a text-only declaration puts none.
- **A native run delivers through Keiko's delivery tools, never the shell (#3897, T12).**
  Standalone OpenCode commits and pushes through its shell. Keiko owns delivery (signed commits,
  bounded refs, ADR-0135; merge is never model-visible, ADR-0087; ADR-0138 D3), so the shell policy
  refuses Git writes and `gh pr`, `repo`, `release` and `api` in every mode, and its refusal names
  the way to deliver (`OPENCODE_NATIVE_DELIVERY_REFUSAL_MESSAGE`; the native guidance names the same
  tools). The native profile therefore registers exactly one group of Keiko tools, through the
  generated `keiko.native-delivery` plugin (`keiko_native_delivery.ts`): `keiko_git_status`,
  `keiko_git_diff`, `keiko_git_stage`, `keiko_git_commit`, `keiko_git_push`,
  `keiko_pull_request`, `keiko_git_execute`, `keiko_ci_status` and `keiko_verification`
  (`opencodeNativeDeliveryTools.ts` holds the list once). `keiko_verification` is a member only
  because a commit proposal requires the commit proof, which `VerifiedCommitService` records solely
  from that tool's verification; without it no native commit could ever be proposed. The plugin is
  the mapped profiles' own generated tool source filtered to those names, so a native call is the
  identical facade request: same capability, wire body, bounds, client deadline and approval
  ask below Full access. **Authority is the facade's alone.** A proposal mutates nothing; the
  operator approves it through the Workbench review per mode (ADR-0124 D6; in Full access the
  existing delivery policy decides, ADR-0138 D3 item 5); `keiko_git_execute` redeems only an
  approved proposal, and merge has no tool. The tools register as the mapped profiles register them
  (`codemode: false`, the `permission` option set to their own name): a Code Mode program cannot
  call them (`Unknown tool`), and the producer hides them from an agent whose rules deny them, so
  Explore (`*` denied) is never offered them while Build, General and Plan (`*` allowed) are, as
  they have the shell. The producer evaluates **no permission** for a plugin tool, measured on the pinned
  executable with a probe plugin beside the real policy (`opencodeNativeDelivery.real.test.ts`):
  the policy hook is never asked, so it adds no second approval and charges no second tool call,
  and a permission that did arrive under such a name would be unclassified and refused. A General subagent's
  child session may call them too; its governed asks (`keiko_verification` in Ask for approval,
  `keiko_ci_status` below Full access) are refused, because the approval lane binds the run's
  primary session, while the proposal and redemption tools ask nothing through it. The native
  settlement owner leaves these calls to the facade that settles them, so run effort counts each
  once. A run readies only with the plugin active (above), because the refusal and the guidance
  point to tools it must have.
- **Process confinement becomes the `keiko-native` profile.** The profile confines the service and
  every descendant it spawns (shells, npm, node, Git), because the native shell tool authorizes its
  working directory and the command as a whole and never routes each file operand through the
  native read guard. The sandbox keeps what the agent's own toolchains need and what standalone
  never guards against, and the kernel boundary is a READ allowlist, not only a write restriction:
  the process reads the task workspace, the run's private state (its `tmp` is the runtime's
  `TMPDIR`), the runtime's own payload, the system software roots and the server-named toolchain
  roots, and nothing else. A toolchain root is a real install prefix that
  `nativeToolchainReadRoots` derives from a `PATH` entry: Homebrew's shared prefix, a prefix
  outside the home, or a directory at least two levels below it (`~/.nvm/versions/node/v24`, a
  JDK, `~/.sdkman/candidates/java/21`). A user-generic bin directory directly under the home
  (`~/bin`, `~/.local/bin`, `~/.cargo/bin`) admits only the bin directory itself, never its
  parent, which holds the user's other state (`~/.local/share/opencode/auth.json`,
  `~/.local/state/gh`, `~/.cargo/credentials.toml`); an executable in it that is a symbolic link
  into a bin directory of a real install prefix additionally admits that prefix. The home
  directory, an ancestor of it and any directory that contains or sits inside a denied location
  are never roots. The
  shared system temporary directories are not admitted: another process's file there is as
  unrelated to the task as any file outside the workspace. Writes are limited to the workspace and
  the private state, except the run's OpenCode configuration directory
  (`<private state>/config/opencode`, named once by `openCodeConfigDirectory` for both the
  environment and the kernel rule): it holds the generated policy plugin and the private
  configuration the runtime only reads, so the filesystem capability's `protectedWriteRoots`
  (bound into the policy digest, strict descendants of a writable root, native profile only) adds a
  final denial of every write operation beneath it (create, overwrite, append, chmod, rename,
  unlink, hard link) and of create and unlink on the intermediate directories, so the directory
  cannot be moved away. A shell child is refused each of these by the real kernel
  (`runtime-gateway.test.ts`, and through the real runtime's own shell tool in
  `opencodeNativeProjectBoundary.real.test.ts`, whose control without the protected root rewrites
  the plugin), while workspace and private-state writes outside it, and the runtime's loading of
  its plugins, are unaffected. Credential stores (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`,
  `~/.azure`, `~/.docker`, `~/.netrc`, `~/.pgpass`, `~/.git-credentials`, `~/.config/gh`,
  `~/.config/gcloud`, `~/.cargo/credentials` and `credentials.toml`, `~/.local/share/opencode`,
  `~/.local/state/gh`, keychains; one list, `nativeHomeDeniedReadRoots`) and Keiko's own state
  directory are unreadable and unwritable even for a shell, and so
  is every credential-named path inside the allowed trees: `CREDENTIAL_PATH_DENY_PATTERNS` in
  `keiko-contracts` (`.env`, `.env.*` except `.env.example`, keys, certificates, token and history
  files, `.npmrc`, ...) is the single list that the native read tool's `isDenied` and the kernel
  rule both read, and the kernel translates it into the last Seatbelt rule, after every re-allow.
  The tool-state half of `isDenied` (`.git`, `node_modules`, caches, `.gitconfig`, `.config`)
  stays a policy guard only, because Git, npm and the build need those paths. A symlink in the
  workspace to a file outside it, and the `/System/Volumes/Data` spelling of a home path, are
  denied at the resolved path. The task workspace and the run's private state are re-allowed after
  the credential-root denials, because the packaged product keeps its managed task workspaces
  inside its own state directory, and the ancestor directory nodes of both are readable (their
  entry names, never their files or sibling subtrees) because the runtime opens the workspace's
  parent to canonicalize it (the 2026-10-23 customer-shape qualification found OpenCode 2.0.10
  unable to `realpath` its workspace otherwise). The runtime's `HOME` is its private state, so no
  user-home dotfile is needed. Executable transitions are inherited. **Process authority is the
  tree's own sandbox (#3901):** the profile starts from `allow default`, so it carries the rule the
  execution-root profile already owns, `OWN_PROCESS_TARGETS_SEATBELT_RULE`:
  `(deny signal process-info*)(allow signal process-info* (target self) (target same-sandbox))`.
  A shell, interpreter or `kill` in the tree signals and reads the process information of itself
  and its descendants (also one reparented to launchd, and process groups of its own children) and
  of no other process of the OS user. The PR audit's `/bin/kill -TERM` against an unsandboxed
  sibling is refused with `Operation not permitted` and the sibling keeps running; another run's
  tree is as foreign as any other process, because each launch is a separate sandbox even when the
  profile text is identical; `proc_pidinfo` of a foreign pid returns nothing. The check is made on
  the sender, so the unsandboxed server still stops the runtime it launched, and the rule is bound
  into the policy digest. It does not hide the sysctl process table (`pgrep`, argument queries);
  `ps` and `top` are setuid and cannot start under any Seatbelt profile, so they are unaffected.
  The kernel proof is `runtime-gateway.test.ts`, with unsandboxed controls for each refusal and for
  the cancellation and toolchain paths that must keep working. **Egress follows the run's
  effective mode and is enforced by the kernel, not only by the per-action policy:** below Full
  access (`governed-assist`, `supervised-coding`) the Seatbelt profile denies all network except
  loopback (the attested Model Gateway, the tool facade and local dev servers), including unix
  sockets and the resolver, so a workspace-approved `npm exec`, `node script.js` or test cannot
  reach a second destination or reuse an ssh-agent or container socket; at Full access
  (`autonomous-delivery`) egress is inherited and stays bounded by the accepted Authority Envelope
  and the per-action policy. An absent disposition means loopback-only (fail closed); the
  disposition is part of the policy digest. The child inherits the launcher's allowlisted
  environment (`PATH`, locale, `TZ`, `TERM`, `SHELL`) with the attested Git directory first, so the
  agent's shell finds the project's toolchains the way it does standalone; the mapped profiles
  still inherit nothing. The launch gate that keeps a host secret out of the child compares the
  child env (allowlisted non-secret names plus Keiko's own run projection) against the host values
  whose name says they carry a credential; comparing against every host value refused each
  Full-access run on a host that also exports the deployment ceiling, because the projected mode
  equalled it. On macOS this is the real Seatbelt profile proven by `runtime-gateway.test.ts`
  against the actual kernel (workspace `.env`, an external canary, a symlink to it and the data
  volume alias are refused for a shell child, an interpreter and a descendant; loopback works in
  every mode; a non-loopback destination is refused before traffic below Full access; Git, node
  and npm still run from the workspace; the nested workspace inside the denied state root still
  works). The native profile is selected on macOS only (`productionOpenCodeToolProfile`); Linux
  and Windows keep the governed mapped profile until their boundary is qualified, and both Linux
  wrappers refuse a native plan (`native-linux-backend-unqualified`). The PR audit executed the
  earlier bubblewrap mount plan in a Linux container: a shell child still read a workspace `.env`
  (credential-named files cannot be named in a mount namespace without enumerating the tree), and
  a fresh network namespace could not reach the host-loopback Model Gateway. A qualified Linux
  boundary must enforce the shared sensitive exclusions for descendants and keep the gateway
  reachable before the native profile is offered there (#3901).
  The spawned-confinement line records `keiko-native`,
  `native-workspace-rw-v1`, `read-write`, `toolchain-inherited` and the `egressDisposition`
  (`loopback-only` or `inherited`).
- **Native asks ride the approval lane without a Keiko action kind.** A policy `ask` reaches the
  orchestrator as a `permission-requested` event whose request names no supervised action kind and
  carries the OpenCode permission it waits on as `nativePermission` (`edit`, `shell`, `webfetch`,
  …), the explicit discriminator `isNativeActionPermissionRequest` reads; commands additionally
  carry a closed `native-*` command label. The run pauses for the human like any ask, and approve
  or deny settle through the permission port alone, with no Keiko authority minted or declined.
  The Workbench enables Approve only once the authenticated review channel shows the action's own
  command, paths or address. An ask the orchestrator cannot challenge is recorded as
  `coding-runtime.event.dropped` with `challenge-invalid` instead of vanishing.
- **The policy hook never clips authority input.** A permission request whose resource list
  exceeds the bounds (64 resources, 2,048 characters each) or holds a non-string is denied in the
  generated plugin without asking policy, because OpenCode would execute the complete original
  action. Reserved Git and `gh` delivery commands are recognised through the effective invocation:
  assignments, transparent wrappers (`env`, `exec`, `nohup`, …), program paths, Git's
  value-taking global options and quoted sub-shells. A repository script that delivers internally
  is outside text classification.
- **Every native permission check is revalidated against live authority, and every native tool
  call costs one tool call once.** After the policy (and any human decision) allows an action, the
  bridge admits it through the tool facade's native-effect owner, which takes the same delegation
  path as a governed tool call: the capability is authenticated, the run must be running on its
  tree binding, the envelope's action classes must include the action's class (checked before
  anything is reserved), and the invocation's one tool call of the run's cumulative budget is
  reserved. Reads are tool calls like any other: an earlier read exemption let 100 distinct reads
  through a 10-call envelope (PR #4064 audit). The reservation is keyed by the original invocation
  identity, a digest of the run and the runtime's own session, message and tool-call ids, so the
  several checks one call raises (an edit and the directory it touches, a repeated evaluation)
  revalidate every time but charge once: the authority's replay ledger answers `authority-replayed`
  for the repeat, which the owner reads as already charged. That ledger is the only memory (one
  entry per reserved call, bounded by `maxToolCalls`, dropped with the run's authority record). A
  child session has its own session id and so its own calls on the same run budget. A check that
  names no tool invocation cannot be recognised again and is charged on its own, so such checks can
  only spend the budget faster. A proposed edit also reserves patch bytes on the same reservation
  (PR #4064 audit: native writes were charged no patch bytes at all): the producer attaches its own
  unified diff of the edit to the permission check (`files[].patch` for `edit` and `write`, `diff`
  for `patch`), the plugin forwards only its UTF-8 size (`patchBytes`), and a budget it would exceed
  refuses the edit before the runtime writes. That is the measure the mapped path charges for a
  materialized patch. An edit the producer attached no diff to cannot apply (no match, or an
  ambiguous one) and spends only its call; a diff the plugin cannot measure is a malformed ask and
  is never allowed. A refused, revoked, expired, exhausted or aborted action is denied and
  recorded as `authority-refused` or `cancelled`; a wiring without the owner refuses every action.
- **Native child sessions inherit the parent run.** A subagent's session is admitted only when its
  `parentID` chain, read from the runtime's own session list, reaches the run's session within
  eight steps inside the run's workspace (at most 64 cached children). Its asks take the parent's
  mode, policy, approval lane and budget; any other session is refused. The decision line records
  the closed `sessionRelation` (`primary`, `child`).
- **A run's session tree decides when the run is over, whose questions reach the human and how a
  refused question ends a turn (PR #4064).** `opencodeNativeSessionTree.ts` owns the ancestry above
  and what hangs on it: a session that is not proven a descendant never keeps a run alive, asks its
  human or receives an interrupt.
  - *Liveness.* The producer keeps a subagent launched with `background: true` working after its
    parent went idle and, when it ends (completed, failed or cancelled), appends a synthetic
    message from `subagent` and runs the parent again to read it
    (https://opencode.ai/v2/docs/tools/#subagent; pinned by
    `opencodeNativeChildLifecycle.real.test.ts`). The adapter's status port therefore answers for
    the whole tree: `activity` (the primary runs), `held` (it is idle and an owned child runs) or
    `terminal`. A success or an interruption settles only when the tree is quiet, confirmed by a
    fresh read at the moment of settlement even when a live hint said otherwise; a failed verdict
    ends the run at once, because settling reaps the tree. The history projection closes the gap
    between a child's end and its parent's restart without a clock: an idle message of a parent
    that launched a background child (a completed `subagent` call naming its session) which has
    not yet reported back is an observation, not the end of the work (`heldIdleCount` on the
    projection line); a failed idle stays a terminal failure. A child that never reports is bounded
    by the run's turn deadline (`maxTurnWaitMs`) like any hang. A stop or turn replacement
    interrupts the primary, then every owned child still running, and the primary again when it
    came back to read a report, and settles on two consecutive inactive reads; budget exhaustion
    and every settled turn reap the whole process tree through the manager. Evidence:
    `coding-runtime.native-session-tree.observed` (`held`, `released`, `interrupted`; counts only,
    a line per change, never per poll).
  - *Questions.* `opencodeNativeQuestions.ts` lists the pending forms of the primary session and of
    its owned children, binds an answer or a rejection to the session that asked, and refuses
    instead of routing a stale id or a form of any other session (another parent chain, outside
    the workspace). Run authority and revision checks stay with the callers. The producer's General
    and Explore agents deny `question`, so a child form arises only for an agent whose rules allow
    it; the lane is correct for it either way. Refusing a child's question interrupts the child
    only, and its parent continues with the failed subagent call. Evidence:
    `coding-runtime.native-question.routed` (action, outcome, relation, counts, a closed refusal).
  - *A refused primary question.* The producer ends that turn with `session.execution.interrupted`,
    removes the session from the active list and writes an assistant message with
    `error.type = aborted`, but no idle message. The live hint is observed only for an execution the
    turn was seen running (a late interruption of a replaced turn settles nothing); the turn settles
    `interrupted` once the tree is quiet and no later verdict was recorded, and the production turn
    port reports it as `cancelled`, not `failed`. The run's own terminal state for a turn that did
    not succeed is the orchestrator's, unchanged. The next turn is armed at once. Evidence:
    `coding-runtime.native-turn.interrupted` (how long the settlement took after the interruption).
- **Version-specific history fields are decoded strictly.** OpenCode 2.1.4's failed idle message
  carries `Session.StructuredError`; the history decoder validates its exact producer shape and
  projects only the body-free terminal failure. Readiness evidence hashes the context guidance of
  the profile actually materialized.
- **The request envelope follows the model window.** The coding run's raw request ceiling is 4 MiB
  (`CODING_SIDECAR_MAX_REQUEST_BYTES`), so the model's declared window, not the wire estimate,
  bounds the context OpenCode plans and compacts against.
- **Projections admit OpenCode's own tool ids.** History, safe-activity and protocol projections
  accept any admissible tool id (native, MCP-namespaced or plugin-registered, shape-bounded); logs
  carry a native id as itself and any extension tool as `extension`.
- **A live native run's newest turn can be undone and restored by the human (B3, S04).** The
  Changes panel offers _Undo last turn_ and _Restore changes_, each behind a confirmation, through
  `POST /api/coding-workbench/runtime/runs/:runId/revert` (`action` `undo` or `restore`; `GET` on
  the same route reads counts only). The coordinator admits it like a follow-up (app session,
  observed revision, one-use request id, a running or paused run) and the dispatcher revalidates
  the live authority as an operator admission, which a paused run passes; the click is the approval
  in every mode, and only the runtime's own snapshots write files, inside the task workspace. An
  undo stops the turn in flight (the runtime refuses to rewind a busy session), stages
  `session.revert.stage` at the first user message of the newest turn and leaves the run live; the
  coordinator reserves the next task generation first, so the interrupted turn's cancelled outcome
  does not settle the run. Keiko never calls `session.revert.commit`: committing, and the next
  prompt after a staged revert, delete the rewound messages, while the history reconciliation is
  append-only per session, so a new turn is refused (`turn-blocked`) while an undo is staged. A
  runtime restores whole files, so Keiko proves each file unchanged by content before it lets the
  runtime write: when a turn settles, Keiko records the SHA-256 of every file the turn changed, read
  through a descriptor that follows no link; an undo of a settled turn is refused
  (`workspace-changed`) unless every file still matches that image, and a restore
  (`session.revert.clear`) is refused unless every restored file still matches the image the undo
  left. Size and timestamps are no witness: a same-size copy that puts the old modification time
  back would pass them. A turn still in flight is the exception: its snapshot covers the whole
  workspace, so a change made while it ran is part of that turn and is undone with it. A settled
  run has no
  undo: its private state, snapshots included, is removed with it. Evidence is
  `coding-runtime.revert.applied`, `.refused` and `.dispatch-failed`: counts and closed words,
  never a path, patch or message.
- **Evidence.** `coding-runtime.native-policy.decided` records, per evaluated action, the mode, the
  closed action name, the effect (`allow`, `deny`, `ask`), the closed outcome (allowed, a hard
  denial reason, the human's approved/denied/expired/cancelled/unavailable, or
  `authority-refused`), the session relation, the risk, the resource count and a digest of the
  resources, never a path, command or URL. An admitted check also carries `invocationCharge`
  (`charged`, `already-charged`, `per-check`) and a refusal `authorityReason` (a closed word: the
  budget, expiry, revocation, a resolution failure, a class outside the envelope, a binding drift,
  no owner, or `other`).
- **A native run's effort roll-up counts the calls the runtime executed.** Native tools run outside
  `execute()`, so the facade never answered them. The runtime's validated terminal tool reports
  (history signals `succeeded` and `failed`, ingested after the reconciler committed them) reach
  the same run-effort owner once per call identity (message and call id; at most 4,096 remembered,
  oldest first): a completed `read` is a workspace read, a completed `edit`/`write`/`patch` an edit,
  and a failure is a refused edit or a failed call, a policy refusal a `denied` one. Approval is
  never counted, and a replayed history read or a reconnect counts a call once. Only the primary
  session's history is read, so a subagent's own calls are not counted (the `subagent` call is).
  The orchestrator's edit outcome (verification requirement and refusal escalation) is not fed: it
  belongs to Keiko's governed verifier, which a native run calls only to record the commit proof of
  a delivery.

What this amendment does not change: the three modes and the Authority Envelope (ADR-0124,
ADR-0129, ADR-0138), the hard denials (ADR-0129 D3), Git delivery as a Keiko product operation
with signed commits and bounded refs (ADR-0135, ADR-0087), evidence redaction (D7) and the one
attested loopback origin for gateway and facade (D4).

