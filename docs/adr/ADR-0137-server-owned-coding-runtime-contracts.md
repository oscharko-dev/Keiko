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
human text. The pinned OpenCode 1.18.30 prompt transport sends context as a separate `synthetic: true`
text part: it reaches the model but the existing safe-activity projection omits its user-message echo.
The combined prompt retains the existing byte ceiling. The Codex control port currently accepts
only text, so its adapter composes the same labelled context after explicit-skill tracking; it never
feeds that composed string back into skill authorization. Follow-up turns carry no implicit context.
The existing body-free `coding-runtime.run.issue-context-attached` event records initial attachment;
raw context stays absent from runtime snapshots, generated runtime configuration and activity logs.

The same server-only `initialContext` field also carries the repository's own working instructions
(2026-10-06). For every run the server reads exactly `AGENTS.md` at the task workspace root — no
other file, no parent directory, no symlink — through the same secure workspace read helper that
answers `keiko_workspace_read`, never a second filesystem path. The model receives the window that
read would answer for the file's first 800 lines, cut at a line boundary to 32,768 bytes and to the
bytes the turn still has under the sidecar prompt ceiling; a cut file ends with one explicit line
naming the total line count. It is framed as repository-authored, untrusted instructions that the
model follows for conventions and verification commands and that grant no authority: they cannot
change the governed tool rules, the Authority Envelope or the autonomy mode, and when the human
intent and the other context parts already fill the prompt ceiling the instructions yield first. The
loader is on by default; `KEIKO_CODING_REPOSITORY_INSTRUCTIONS_ENABLED=false` disables it and any
other explicit value fails composition closed. The body-free
`coding-runtime.repository-instructions.context` event records the outcome under the run's
correlation id (`attached`, `truncated`, `absent`, `disabled`, `refused`) with the attached byte and
line counts, the file's total counts when cut, and the whole-file SHA-256 the read tool reports for
the same file; only a genuine read failure is `refused`, recorded at `warn` with its closed reason,
and it never fails the run. The helper reports a missing root file and a denied one alike, so both
are `absent` with the helper's own reason retained. The helper delivers whole files up to its
content ceiling of 65,536 bytes, pinned in its wire protocol and its digest-pinned native binary, so
a larger `AGENTS.md` is refused as `too-large` until that protocol gains a bounded window; lifting
the ceiling is a helper-protocol decision, not a loader change.

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
The allowance is the only default per-run token bound: a Model Gateway spend ceiling is enforced
only where an operator configures one. The former defaults (200,000 tokens and a fixed 30 minutes)
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

**A run whose edits keep being refused settles instead of looping** (F5 of the live Gemma
qualification, #3873). A run whose workspace had no connected Workbench logged eleven
`coding-runtime.edit.refused` lines with `NO_ACTIVE_SESSION` until the operator stopped it: nothing
above the edit port counted the refusals, and the model resent an edit no change of its own could
make apply. Each run's tool facade now reports every applied or refused governed edit, as the model
received it, to the orchestrator, which counts the run's consecutive refusals with the same closed
reason code. Other tool calls between two refused edits do not interrupt the count — re-reading the
file is exactly what the refusal guidance asks for — while an applied edit or a refusal with another
reason restarts it, and a human's rejection of a change in its review is a decision, never a refusal
(ADR-0124 D6). Refusals that land while an operator has the run paused are not counted. A refusal the model cannot repair by changing its edit — no connected Workbench editor
(`NO_ACTIVE_SESSION`, `NO_ACTIVE_BRIDGE`), lost workspace access, a denied path or policy
(`OUT_OF_SCOPE`, `POLICY_DENIED`, `APPROVAL_REQUIRED`), a buffer only the operator can save, an
editor or transport fault — settles the run `failed` with `edits-blocked` at the third consecutive
occurrence (`UNREPAIRABLE_EDIT_REFUSAL_BOUND`). A refusal the model can repair — an edit that does
not apply (`INVALID_EDITS`), a stale base (`CONTENT_HASH_MISMATCH`, `VERSION_MISMATCH`), a missing
precondition, or a refusal that carried no closed code — keeps its guidance and settles the run with
`edit-retries-exhausted` at the sixth (`REPAIRABLE_EDIT_REFUSAL_BOUND`). The escalation writes one
`coding-runtime.run.refusal-escalated` line (`reasonCode`, `refusalClass`, `consecutiveCount`,
`bound`, `failureCode`); the run then settles through the same path as a failed turn, its runtime
stopped and its changes kept in the task workspace, and `coding-runtime.run.settled` carries the
cause with `failureBasis: "refusal-escalation"` and `refusalReasonCode`. The bounds are fixed: every
refused attempt resends the run's growing context, so a loop spends the prompt allowance on nothing.

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
flight (`coding-sidecar.gateway.outcome` `cancelled`, `cancellationCause=run-stopped`). At settlement
the orchestrator reads, before it stops the runtime, the facts the owning layers hold: the runtime
authority answers whether the run's most recent model-call admission was refused by the cumulative
prompt allowance itself (not by the runtime's time budget, expiry, revocation, or a run state that
admits no model call) and whether the run's envelope ran out of time (`maxRuntimeMs` after minting
or `expiresAt`, whichever comes first), and the control plane's event hub keeps the closed cause the
coding sidecar gateway reported for the run's most recent failed model call until a later call of
the run is answered. In that order, the run settles `prompt-allowance-exhausted`,
`envelope-duration-exhausted`, `output-exhausted-repeated` (the gateway's `output-exhausted`, which
ends a run only after the gateway's one steered repair or the runtime's retries exhausted the budget
again), `provider-unavailable` (the gateway's `stream-incomplete`: a timeout, a refused or dropped
connection, a stream that broke before the answer completed), or `model-turn-failed` (any other
failed-call cause, which the failed turn's own frame names), and `runtime-failed` (the runtime
crashed or failed internally) only when no such cause is on record. A run whose refused edits
escalated (above) comes before all of these facts: it settles `edits-blocked` or
`edit-retries-exhausted` whatever its last model call reported. A run the operator stopped
settles `cancelled`, as before, and the Workbench says the operator stopped it. Nothing is read
from OpenCode's error text. `coding-runtime.run.settled` records the cause with `failureBasis`
(`prompt-allowance`, `envelope-duration`, `model-call-failure`, `no-model-call-failure`, or
`refusal-escalation` for an escalated run) and
`modelCallFailure`, and an error class that matches it instead of `internal`. The gateway reports a
provider that stayed unavailable past the outage window (a 5xx, 408 or 429, an open breaker) with the
same `provider-failed` code as a 4xx rejection, so such a run settles `model-turn-failed` until the
gateway reports a distinct cause for the unavailable class.

**A settled run carries its effort roll-up** (#3873), so one line answers how many model turns and
tool calls the run made and where its time went. `coding-runtime.run.settled` adds counts and
durations only, each counted in process where it is observed: `wallDurationMs` (creation to
settlement); `modelTurnCount`, `modelDurationMs` and `promptTokensTotal` at the run's model-gateway
capability, where the sidecar gateway reserves a call's prompt estimate immediately before dispatch
and settles it once the provider answered or failed (a released reservation is no call, and a
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
authority: every filesystem, command, network, connector, and delivery effect must be mediated by a
Keiko-owned governed tool boundary.

Codex subscription traffic remains a distinct runtime/model source. Its egress uses Keiko's shared
enterprise proxy and custom-CA path, and any official authentication navigation target is validated
server-side against the closed official-origin policy before the browser may open it. Credentials
never enter browser intent, runtime events, or adapter launch configuration.

Content-bearing live prompt, response, model-reasoning (see the Issue #3878 amendment), diff, and
diagnostic events are transient, bounded, and access-controlled. Durable operational events and
evidence are a separate content-free projection; they carry only ids, digests, counts, booleans,
closed states/codes, and safe labels.

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
  it as a collapsible "Model reasoning" block labelled as unverified model reasoning, open while its
  turn streams and collapsed once the turn completes; the boundary copy says what is shown instead
  of promising that reasoning is never exposed.
- **Bounded, and the first content to go.** Reasoning keeps to half of a message's live byte
  budget, yields room to the answer within its message, and is the first content evicted under turn
  or feed byte pressure; the newest message keeps the reasoning that may still be streaming.
- **Never evidence.** D4's durable rule is unchanged: reasoning never enters Coding History,
  evidence, a support export or the Activity Log. Durable lines record only counts — reasoning
  events, bytes, provider-reported reasoning tokens, frames and a closed disposition — never text.
