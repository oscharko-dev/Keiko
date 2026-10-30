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
answers `keiko_workspace_read`, never a second filesystem path. That read proves the file's path,
type, size and identity, not that its text is free of credentials, so the text then passes the one
canonical model-safe projection of workspace text (`redactWorkspaceSource`, the
`@oscharko-dev/keiko-workspace/source-redaction` subpath) before anything is bounded, attached or
copied; a file that projection cannot handle is `refused` with `redaction-unavailable`, and the
recorded digest stays the file's own (PR #4064 review r4369385467). That helper resolves its root from
the global active pointer, so the read is bracketed by the run's own exact-workspace check before
and after it (`exactWorkspaceRead`, shared with the auxiliary ports): a workspace switch while the
run starts is recorded as `refused` with `workspace-unavailable` and never attaches another
repository's file (#3873 review). On the mapped profiles the model receives the window that read
would answer for the file's first 800 lines, cut at a line boundary to 16,384 bytes and to the
bytes the turn still has under the sidecar prompt ceiling; a cut file ends with one explicit line
naming the total line count. That block rides in the first message and is re-sent with every turn,
so the context line records its estimated tokens, its per-turn cost against the run's prompt
allowance. It is framed as
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
line counts, the byte bound the read was cut against (`limitByteCount`), the file's total counts and
the bytes left out (`omittedByteCount`) when cut, and the whole-file SHA-256 the read tool reports for
the same file; only a genuine read failure is `refused`, recorded at `warn` with its closed reason,
and it never fails the run. The helper reports a missing root file and a denied one alike, so both
are `absent` with the helper's own reason retained. The helper delivers whole files up to its
content ceiling of 1 MiB, pinned in its wire protocol and its digest-pinned native binary. This
bounded whole-file read admits ordinary large repository instructions and retains the whole-file
digest for edit preconditions. The native helper allocates only the observed file size plus one
growth-detection byte; it still checks final file and directory identity and rejects concurrent
changes. Model-facing read windows remain capped at 64 KiB, and the initial-turn block of the mapped
profiles remains capped at 16 KiB and 800 lines; the native copy is not (below). An oversized requested model window returns the existing
`workspace-read-too-large` refusal and a body-free failed-read event so the model can request a
smaller line window. Files above 1 MiB remain refused; neither a tool argument nor this loader can
override the pinned helper ceiling.

On the native profile the same read reaches the model through the producer's own
instruction plugin instead of the first message (#3900 AC3, 2026-10-25). Keiko writes it, under a
header that labels it repository-authored and untrusted and grants no authority, to `AGENTS.md` in
the run's private configuration directory: the pinned 2.1.4 runtime's global instruction file,
which the agent cannot write. The producer watches that one slot from launch (a configured
`instructions` source is watched only when it exists at launch, so it would miss a file created
during the run), so Keiko refreshes the copy before the launch and before every turn, through the
same exact-workspace read, renaming a complete file into place or removing it when nothing is
admitted. After a change the turn waits out the producer's watcher before its prompt, so an edit, a
file the guided `init` command creates and a removal reach the next model call as the producer's
own instruction update. The initial turn then attaches no block, so the text reaches the model
once; the mapped profiles keep the first-message block. The copy carries the whole
credential-masked file, as a standalone run loads its AGENTS.md (2026-10-29): the 16 KiB/800-line cut
belongs to the first-message block alone. It is bounded by the helper's 1 MiB ceiling and by the
run's prompt budget, half the model's input window at three bytes per token
(`repositoryInstructionsCopyBudget`, from the geometry the run launches with; about 168 KiB on a
131,072-token window). A file beyond that budget arrives cut at a line boundary with the explicit
truncation line instead of failing every turn on a window it cannot fit, and the context line then
records the bound and the bytes left out. The `instructions` setting is server-owned
and empty, so no layer can name a source the run would read itself. Each refresh records the same
`coding-runtime.repository-instructions.context` line, and a copy that cannot be written is a
`refused` line with the `exception` reason, its frames and cause chain, never a failed turn.

The same copy carries the further sources a standalone run loads (#3900 AC3,
`codingRuntimeInstructionSources.ts`), in the producer's own order: the user's global OpenCode
instructions (`AGENTS.md` in `$XDG_CONFIG_HOME/opencode` or `~/.config/opencode`), the workspace
root's file, every `AGENTS.md` above the workspace up to the producer's stop (the home directory
when the workspace lies inside it, otherwise the repository root that contains it), then each
`instructions` entry of the user's global `opencode.json`/`opencode.jsonc` and of the project's
`opencode.json`. The run reads none of them itself: its kernel profile keeps it inside the
workspace and its project layer stays off. Keiko reads a source outside the workspace as an
owner-private regular file opened without following a link (an ancestor with a second link is
refused), and a workspace entry through the same exact-workspace read, expanding `*`, `?` and `**`
through the secure native listing (bounded; `[...]` and `{...}` are refused, never approximated).
A project entry never names a file outside the workspace; a global entry may name the user's own
file. A remote (`https://`) entry is pulled once per run, only for a run launched in Full access,
through Keiko's egress with no redirect and no loopback or private target; below Full access it is
refused. Every additional source passes the same credential projection and the 16 KiB/800-line bound
under a line naming it (only the workspace root's file travels whole); together the additional sources stay within 48 KiB, and what does not fit is
omitted and counted. The context line adds per-kind counts (`globalSourceCount`,
`ancestorSourceCount`, `configuredSourceCount`, `remoteSourceCount`) and the refused and omitted
counts; a failed discovery or remote pull is its own `refused` line (`sourceKind`) with frames, and
the root file's copy is kept. `KEIKO_CODING_REPOSITORY_INSTRUCTIONS_ENABLED=false` disables every
source. 2.1.4 reads no `CLAUDE.md`.

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
delegation. The cumulative patch allowance `budget.maxPatchBytes` is not an operator setting: every
envelope is minted with `CODING_RUNTIME_PATCH_BUDGET_BYTES` (64 MiB, owner decision 2026-10-28;
previously 256 KiB), eight changesets of the per-changeset cap of ADR-0125 D3, charged by the size of
the diff each edit renders. Native context compaction changes subsequent request size, not
cumulative accounting.

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

**A run with no issue binding delivers by pushing its own task branch (owner decision,
2026-10-30).** The Coding Workbench works without any issue binding; the binding is a legacy
leftover and is not a delivery precondition. The draft delivery context of such a run resolves like
any other, and `keiko_git_push` proposes pushing the run's verified commit to its own task branch on
`origin`, which may be any Git remote. The proposal is redeemed with `keiko_git_execute`
(`kind: push`) under the existing delivery approval plane (ADR-0085 D1b); protected targets stay
blocked and a force push is never constructed. A pull request never depends on an issue
(ADR-0086 D13): on a verified github.com origin `keiko_pull_request` opens a draft pull request from
the task branch with no closing line, and an accepted issue only links it; on any other remote it
refuses with `github-origin-required`. Every refusal of the delivery controller is
now written as a `git.draft-delivery` line (`phase: refused`, a closed `reason`, `errorKind`,
the run's correlation id), and the coding tool facade forwards the complete
`CODING_RUNTIME_DELIVERY_UNAVAILABLE_REASONS` vocabulary, including `repository-required`,
`remote-required`, `github-origin-required` and `issue-binding-required` (the CI observation of a
pull request opened without an issue), with guidance text for the delivery action, so the
model learns the true cause instead of inventing one ("remote inaccessible", live lab 2026-10-30).

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
The original service host that could enter that callback over closed `native-initialization`
packets on the authenticated tool route was removed with the host (#3897, see "Service host
removed" below); the route no longer recognizes those packets.

The separately inactive original Read-parent transport also uses the existing authenticated tool
route. Closed begin/byte/stat/list/close packets require the existing admitted run's actual ready
state, observed exact session, current accepted root and captured native Read facet. They preserve
the canonical parent identity, replay/ordinal controls and single authority charge. Failed or
cancelled close validates that identity before aborting only its existing admission controller.
Completed close does not cancel unrelated work. Returned settlement joins actual physical work and
the same idempotent slot release, so response disconnection cannot free a still-running reader.
Private controls use genuine authority/Manager admission with hermetic endpoint and supervisor
readiness; they do not activate a native advertisement.
The existing rejection operation records the closed `native-read-refused` reason without bodies.

A separately pinned `KSR3/KSS3` facet supplies bytes, ranges, descriptor metadata and immediate
directory entries to original native file consumers. A verified helper declares it only when its
verified source is the helper source of a current runtime approval
(`secureWorkspaceReadNativeProtocol`, never on Windows); the published 1.1.3 helper keeps text IO
only, so the repository-item loader reports `listing-unavailable` there until the replacement
runtime packages are published (#3897 review, #3898). Its collected output limit is
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

**Service host removed (#3897, owner decision of 2026-10-24).** An inactive original Node service
host built for OpenCode 2.0.10 (its supplemental artifact identity, the private npm candidate path,
the supplemental disk inspection, the prepared Manager program with its bounded startup packet, and
the `native-initialization` transport) was never selected in production: every native run starts
the original pinned OpenCode binary directly through the ordinary prepare and handshake path. The
host, its contract (`keiko-contracts/runtime/opencode-service-host`), its artifact owner, its private
lock and its CI and supply-chain coupling were removed. `OPENCODE_TOOL_PROFILES` and
`OpenCodeToolProfile` moved to `keiko-tool-catalog`, which already owns the profile concept.
Portable approvals no longer accept a `serviceHost` facet, and the license preflight validates the
root lock alone. The generated plugin sources of ordinary runs are byte-identical before and after
the removal.

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
relative path only when materialization identified it; a governed verification's closed outcome
(`passed`, `failed-check`, `waiting-for-trust`, `no-runnable-steps`, `not-run`, #3579); and elapsed
bridge service time. Service time includes governed waits and excludes model generation. These
facts come from the governed producer, remain bounded by the existing aggregate feed limits, and
survive native restatement and immutable replay. Raw arguments/results, unknown refusal strings,
unknown outcomes and unsafe paths are rejected. The verification outcome is derived from the closed
result code the model received (`codingToolVerificationPresentation`), so the timeline shows a
package-script decision still waiting on the operator, a repository with nothing the verifier can
run and a run whose steps were skipped, denied or cancelled as what they were and not as a failed
check; only a check that ran and went red keeps the failed badge, and a timeout, a resource ceiling
or a refusal before the runner claim nothing beyond the generic failure.
Paths never enter Activity Log evidence, model-facing edit refusal replies or Coding History;
the existing tool-result operation records service duration through its standard duration field,
and the existing `coding-runtime.tool-result-rendered` operation records the closed verification
outcome as an optional field, declared `diagnosticWhen` for every outcome but `passed` so a support
report keeps a verification that did not pass.

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

A task's History can also leave the machine's UI store, and only by the human's own action (#3904).
Export JSON and Export Markdown in Coding History call `GET /api/coding-workbench/history/:id/export`
(`format` `json` or `markdown`), which is admitted like every other History read: a paired app
session, then the task's operator ownership, an unpaired caller and another operator's task answering
exactly like an unknown one. The server returns the file's exact text and the browser saves it through
its own download path; nothing is uploaded and the server keeps no copy. The History store redacts
only `shortResult` and grounded-answer metadata, not message content, which is stored as the runtime
produced it, so every string of the export (messages, title, branch) is redacted again at this
boundary with the product's evidence redactor (built-in secret shapes plus the live configured
literals). Paths under the task's workspace become workspace-relative, any other absolute path is
masked with the shared `redactAbsolutePaths` (over-redacting path-like text is accepted), and the
repository appears as its folder name only. The `keiko-coding-task-export` document (schema version 1)
carries the Keiko version, the OpenCode version this build pins as a build fact (not an observation
of a running runtime), the task's title, status, branch, timestamps and run ids, and the stored
messages in order with role, text and time. Neither the run's mode nor its changed files are in
Coding History, so neither is exported. A file stays within 8 MiB: the newest messages that fit are
kept, the older ones are counted as omitted, and only a file that cannot hold its own header is
refused (413 `CODING_HISTORY_EXPORT_TOO_LARGE`). An unknown `format` is a 400. A saved export is data:
the human may place it in a workspace and attach it to a new task with an `@file` reference, which
admits any UTF-8 text file of at most 64 KiB (`opencodePromptInputs.ts`), or import it, and the file
grants no permission or authority. The body-free `coding-runtime.history.export`
operation records `requested`, then `completed` or `refused` (closed reasons `unauthenticated`,
`unavailable`, `invalid-format`, `too-large`, `failed`) with the format, message, omitted and
redacted-message counts and the byte size, never any text; a failed browser download is reported
through the client diagnostic sink.

Import task in Coding History (#3904 AC4) is the same boundary in the other direction. The human
picks one file on their device; the browser sends it to `POST /api/coding-workbench/history/import`,
admitted behind a paired app session (an unpaired caller answers like an unavailable History and the
file is never read), and the server stores its conversation as a new task of this operator in the
active workspace (409 `CODING_HISTORY_IMPORT_NO_WORKSPACE` without one, or while its identity cannot
be proven). Nothing is fetched or sent anywhere else. Two documents are read: a
`keiko-coding-task-export` of schema version 1 (closed keys; a newer version is 400
`CODING_HISTORY_IMPORT_UNSUPPORTED_VERSION`), and an OpenCode session transcript, of which only the
visible text parts are kept. Anything else is 400 `CODING_HISTORY_IMPORT_INVALID`, a file without
conversation text 400 `CODING_HISTORY_IMPORT_EMPTY`, and a file above 16 MiB 413
`CODING_HISTORY_IMPORT_TOO_LARGE`; a refused file stores nothing. The file's text is as untrusted
as any input, so every title and message is redacted again with the evidence redactor, absolute
paths are masked and unsafe format characters stripped; the title is one line of at most 100
characters, times are kept in order and never in the future, and only the newest 200 messages are
kept. The task is marked `origin: "imported"` and has no run of its own, so it is never continued
in place: the Workbench forks it as it ended (D10's fork, without a cancel), and the person may fork
before one of its messages instead. The runtime's own session import stays unreachable. The
body-free `coding-runtime.history.import` operation records `requested`, then `completed` (source,
message, omitted, skipped and redacted-message counts, byte size) or `refused` (closed reasons
`unauthenticated`, `unavailable`, `no-workspace`, `invalid-document`, `unsupported-version`,
`too-large`, `empty`, `failed`), never any text; a failed import is reported through the client
diagnostic sink.

Delivery approval, one rule for D3 and D4. In `governed-assist` and `supervised-coding`, commit,
push and pull-request create/update each require their own action-bound, one-use human approval in
addition to runtime authority; no connector scope or earlier start confirmation pre-approves them.
`autonomous-delivery` is the one mode whose accepted Authority Envelope authorizes those three
actions inside the envelope without a per-action approval (ADR-0129 Full access, ADR-0138 D2): the
policy decides `allowed`, every effect still runs through the governed delivery tools, and D3's
delivery-truth rule decides whether the run delivered. Merge and Authority Envelope widening
require their own human approval in every mode (ADR-0087).

A run's runtime database is private per-run state and is removed with the run's state root. A crash
or a disposal that failed can leave that root behind, so the server sweeps it once at startup: every
directory under the owned `<state>/coding-runtime/opencode` base whose run is neither live nor
recoverable (no snapshot, or a settled one) is removed, never following a symbolic link, never
leaving the owned base, and recording only counts on a body-free diagnostic. The live run window
reads the newest 4096 messages of a longer session (marked truncated, never replacing the captured
Coding History conversation) instead of failing every read; the strict complete read above that
bound still refuses a longer session for continuation. The one
runtime state that outlives a run is the retained session entry of D10 (S02, S03, #3904): it is
server-owned under the state directory, outside every workspace and run root, one entry per task
and bounded, and it is never authority, because a later run mints, bounds and approves its own.

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
  until the reader opens it. The label is the opened block's first line and the timeline's boundary
  copy, not a badge on the summary: the summary sits among tool rows whose badges are statuses, and
  a warning-coloured "Unverified" there read as a failed check on every step (#3897, owner
  feedback 2026-10-27). It stays collapsed also while its turn streams. The session stream is a
  `role="log"`, whose additions a screen reader announces, so up to 8 KiB of unverified reasoning per message
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
- **A read follows the newest messages, not the whole run (#4104).** Re-reading and re-projecting the
  session on every hint cost the conversation's length per event. Once the previous pass is
  committed and caught up, the projection plans an anchor — a message a bounded number (32) of
  messages before the end — and the read (`recentMessages` with the anchor) stops there, handing the
  projection only the messages from it on. The runtime completes a streamed part in place, so every
  message from the anchor on is read and projected again, while the older messages, their candidates
  and the conversation Coding History captured from them are carried over. The projection resumes
  with the anchor's own scan state (the user message answered and the background children launched
  and reported so far), so the output equals a full projection of the same session. A complete read
  takes over, and the line says so with `readMode`, when the anchor is no longer in the session
  (`anchor-lost`: a revert or compaction), every 256 tail reads (`verify`, which catches an edit to
  a message older than the tail), after a pass cut at the 256-event cap or with an uncommitted page
  (`full`), and while a message older than the tail still holds live text the history has not shown
  complete. `readMessageCount` and `retainedMessageCount` count the messages handed over and carried
  over. The continuation's complete read (`mode: "complete"`, 4096 messages, `history-oversized`) is
  unchanged.
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
  `update` and `share` off (a session is never published, and OpenCode 2.1.4 has no share operation;
  the equivalent is the human's local export and import of a task's Coding History, D4), keeps the single `keiko-runtime` provider behind the Model
  Gateway, and enables native snapshots. The producer appends configured rules after each built-in agent's own
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
- **A Code Mode session move stays inside the task workspace (#3903 AC4).** The policy plugin sends
  `opencode_session_move`'s `directory` and the session it names to the policy. The run's own
  session may move to an existing directory inside the task workspace, named by its absolute,
  normalized path with no symbolic link on the way; that is navigation inside the workspace, so it
  is a read in every mode. The run's session tree records the directory before the move happens
  (at most 8), so the child sessions and background jobs the moved session starts are still the
  run's: the runtime lists a job under its session's directory, and the tree's stop reaches it
  there. Another session, a place outside the workspace, a symbolic link, a file, a missing or a
  relative directory are refused (`unsupported-action`, `workspace-escape`) and move nothing. The
  Files root, the Authority Envelope and the task binding stay the task workspace. A moved session
  is not retained for a later continuation: the retention audit finds its directory changed
  (`session-mismatch`), so the follow-up starts a fresh session.
  `opencode_worktree_create` adds a new branch and worktree, so the policy classifies it as a
  delivery-scoped action the human decides in every mode, Full access included; the hook sends the
  name it carries, which must be one plain name (letters, digits, dots, dashes, underscores, at
  most 64). An approved request is provisioned by the existing managed task-workspace owner
  (`opencodeNativeWorktree.ts` over `WorkspaceProvisioningService.provision`): a new task workspace
  from the active workspace's repository, branched from the run's current task branch, recorded
  with the run's correlation. The producer's own call is always blocked, so no unmanaged git
  worktree is ever added; the model reads Keiko's result, labelled creation only, as the call's
  message. The run keeps its
  binding: the new workspace opens as its own task, and the model's own session move into it stays
  refused. The decision line records how it ended (`worktree`: `provisioned`, `resumed`,
  `unavailable`, `workspace-changed`, `provision-failed`).
- **A task continues in a workspace provisioned from its own only as a fork started there (#3903
  AC4, #3902 AC3).** The person switches to the new managed workspace (Task Workspaces) and forks
  the task; the new run is minted, bounded and approved for that workspace like any other, and the
  source run keeps its binding (no live rebinding, no second path). The continuity context names
  the run's provisioning source: the one other settled managed workspace of the same repository
  whose task branch is the run's base branch (`provisioningSource`, `opencodeNativeWorktree.ts`;
  none when there is none or more than one). The retention store admits the fork's entry only when
  its manifest is bound to exactly that source's key (its workspace id and root), only for
  `purpose: "fork"`; any other key stays `workspace-changed` and leaves the entry. The copy passes
  the unchanged audit (no grant, credential, pending input or staged revert) at the source's
  location, and the runtime's own `session.move` (`POST /api/session/{sessionID}/move`, admitted
  for this alone, re-projected pins 2.1.4 `941a8788…` and 2.0.10 `285ecf83…`) places the session at
  the run's root before the fork; a refused move is `move-failed`, a session the move left
  elsewhere `session-mismatch`. The source task's entry is never touched and still resumes in its
  own workspace. Evidence: `coding-runtime.session-continuity` with `relocated: true` on the fork's
  line and the closed reason `move-failed`.
- **Accepted external references are read-only and named before the run (#3900 AC5).** The
  operator names directories in `KEIKO_CODING_EXTERNAL_READ_ROOTS` (absolute, separated like
  `PATH`, at most 8). `opencodeNativeExternalRoots.ts` resolves them once per native run, all or
  none: an entry that is not an existing directory reached without a symbolic link, a top-level or
  home directory, one that overlaps the workspace or the private state, or one inside a denied root
  refuses the whole set (`coding-runtime.native-external-roots.resolved`, closed reason, counts
  only). The one resolution binds the kernel read allowlist (`externalReadRoots`; the denied roots
  and credential names still win inside it), an `external_directory` rule per root that hands each
  read to the policy, and the producer's own local `references` (named `external-1`, …). The
  policy decides each read there as an `external-file` action of the run's mode (asked below Full
  access), keeps the workspace's sensitive-path and hard-link refusals, and refuses every write. The
  Linux mount allowlist names no external root yet, so none is admitted there; repository
  references would leave the machine and stay refused.
- **Web search runs through the search integration the operator admitted (T15, #3903 AC3,
  PR #4064 review).** The pinned 2.1.4 `websearch` asks the policy for its query and then calls the
  selected provider of the runtime's websearch service; with no provider selected it waits on the
  user's choice. The generated `keiko.native-delivery` plugin registers Keiko's provider, `keiko`,
  as that service's default (`ctx.websearch`), so the original tool, its permission ask and its
  result formatting stay OpenCode's, while the search runs in the server (`nativeWebSearch.ts`):
  only with an integration the operator admitted (`KEIKO_CODING_WEBSEARCH_ENDPOINT`, an Exa-style
  MCP endpoint, https or a loopback http service; an optional `KEIKO_CODING_WEBSEARCH_API_KEY` that
  never reaches the runtime: the provider receives it in its query string, so every occurrence it
  echoes, as sent, percent-encoded or form-encoded, leaves its answer before a result field is
  read), only for the exact query the run's policy has just allowed for that
  run (a one-use grant), and through the gateway's outbound transport with the deployment's proxy
  and CA, one POST to the configured host, no redirect, bounded time, bytes and results. With an
  integration, `websearch` is an internet action like `webfetch`: Full access allows it, narrower
  modes keep the honest refusal. Without one the policy refuses it at once in every mode
  (`unsupported-action`) and names the alternative, `webfetch` of a known URL, which Full access
  allows through the policy with inherited egress. `coding-runtime.websearch.performed` records the
  outcome, counts, sizes, duration and whether the key had to be removed (`credentialRedacted`),
  never the query, a result, the key or the endpoint. Real binary,
  production composition: a fixture-owned loopback search service answers one Full access search
  the model then reads; Supervised workspace and an unconfigured server search nothing.
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
- **Managed providers (#4089):** [ADR-0181](ADR-0181-shared-managed-mcp-host.md) adds a shared in-process protocol host for governed non-OpenCode consumers. Its server-declared providers do not enter the operator registry below; that registry, relay and OAuth contract remains unchanged.
- **MCP servers come from the operator's registry, never from the repository (#3903, parity row
  C04, owner decision of 2026-10-24).** `mcp-servers.json` in Keiko's state directory, owned by the
  user Keiko runs as and writable by nobody else, is read for each native run at its launch
  (`mcpServerRegistry.ts`; the grammar is `parseMcpServerRegistry` in `keiko-contracts`, so Chat and
  other components can consume the same registry later). A local server is an absolute executable
  with literal arguments and literal, non-secret variables, a remote server an `https` URL, and every
  tool is named with its declared risk (`read` or `write`); a `{env:…}` or `{file:…}` placeholder is
  refused anywhere, because the runtime resolves it from its own environment and files. A file Keiko
  cannot trust (a link, another owner, group- or world-writable, over 64 KiB, not JSON, an invalid
  entry) admits no server. `opencodeNativeMcp.ts` writes the admitted servers as `mcp.servers` on the
  server-owned binding, always present so no lower layer can add one. The pinned runtime starts a
  local server as its direct child and hands it its whole environment, Keiko's gateway and tool
  capabilities and the service password included (proven on the original executable), so a server
  starts through `/usr/bin/env -i` with a fixed `PATH`, the run's private `HOME` and its own
  variables only. It runs inside the run's sandbox; its executable's install prefix is opened for
  reading under the same toolchain rule as the launcher's `PATH`, and the supervisor's resource
  coalition reaps it with the tree. A remote server is written only for Full access; without an
  operator-named issuer its OAuth stays off.
  The runtime exposes MCP tools through Code Mode, and every nested call reaches the policy as
  `<server>_<tool>`: a named local `read` tool is a vetted command (Ask for approval asks,
  Supervised workspace and Full access allow), a named local `write` tool a risky command (Full
  access allows), a remote server's tool internet use (Full access only), and the resource tools of
  admitted servers are reads of those servers. Every other MCP action stays unsupported. Evidence:
  `mcp.registry.loaded` (consumer, state, counts, a digest of the admitted definitions, the closed
  reason) and `coding-runtime.native-policy.decided` with `permission: mcp`; no server, tool, path
  or URL enters the log. Open: a confidential OAuth client's secret, a registry editor and the
  first consumer outside Coding.
- **A remote MCP server's static credential stays in Keiko, behind its relay (#3903 AC3).** A remote
  registry entry may carry `headers: { "<Name>": { secretEnv, prefix? } }` (at most 8, never with
  `oauth`): each value is read from the named `KEIKO_MCP_SECRET_*` variable of Keiko's own
  environment, so no credential is written in the registry and no other variable can be named;
  transport, connection, cookie and Keiko headers are refused. The run never holds the value: its
  binding addresses `/api/coding-sidecar/mcp/:relayId` on the same attested loopback origin as the
  Model Gateway, with `oauth: false` and two headers the runtime sends on every request,
  `X-Keiko-CSRF` (so the route keeps the ordinary CSRF guard, no exemption) and
  `X-Keiko-Mcp-Relay`, a capability minted for that run and that server (`mcpCredentialRelay.ts`,
  stored as a hash, compared in constant time, at most 256 bindings). The relay refuses a browser
  origin or a wrong capability before any request leaves, adds the credential headers and forwards
  the MCP Streamable HTTP request (GET, POST, DELETE; only `accept`, `content-type`,
  `mcp-session-id`, `mcp-protocol-version` and `last-event-id` pass, 4 MiB request, 32 MiB
  response) to exactly the registered URL through Keiko's egress (no redirect followed, loopback
  and private targets refused); a redirect answers 502. A server can answer with the credential it
  received, so the response is not passed through unread: the relay replaces every spelling of
  each header value and each bare credential that a JSON parser, a URL decoder or a browser turns
  back into it, before the run reads it. Each character may be written as itself, as JSON's
  `\uXXXX` or short escape (once, and again inside a JSON text), percent-encoded, as a form's `+`
  for a space or as an HTML character reference, in any mix; base64 and base64url text holding a
  credential is matched at each byte alignment. HTML references follow the WHATWG grammar a browser
  applies (PR #4064 review): a numeric reference takes every digit, leading zeros included, with or
  without its semicolon, and a named reference is the longest name of the table, case-sensitive,
  the legacy names also without their semicolon; every named reference standing for printable
  ASCII is recognized, and a reference Python's `html.unescape` drops (a control character or a
  noncharacter) counts as standing for nothing inside a spelling. Only text decoding to an exact
  credential is replaced, never a heuristic shape (`createSecretSpellingStreamRedactor` in
  `keiko-security`, which accepts printable ASCII secrets only); text that may still complete a
  spelling across the next chunk waits for it, and a line break never waits, so an event stream
  still flows event by event. A response that keeps a spelling open for more than 256 Ki
  characters, more than the longest credential spelled with its longest references needs, is cut
  off there and nothing it held is published (`credential-spelling-unbounded`). A credential needs
  at least 16 characters (`secret-too-short` otherwise): a shorter one could not be told apart from
  ordinary text, and its base64 core at every alignment has at least 20 characters, so none is
  left unprotected. A forwarded response header is read back by the run as it is (the
  session id is echoed on every request), so a header that spells a credential cannot be rewritten:
  the response is refused (502, `credential-in-response-header`). A server that deliberately
  re-encodes its credential some other way still receives it on every request; the relay keeps the
  credential out of the run's configuration and out of an echo, not out of a hostile server's
  hands. A run's disposal releases its bindings and ends every exchange it
  holds. The server-owned binding (`OPENCODE_CONFIG_CONTENT`) joins the
  shell environment denylist, so an agent's shell cannot read a capability. A server whose secret
  is unset, holds a line break or is shorter than 16 characters is left out with its tools. Evidence: `coding-runtime.mcp-relay`
  (bind: relayed and refused server counts with the first closed reason; request: method, status,
  request/response bytes, the count of replaced credential occurrences (`redactedCount`), duration,
  outcome `relayed`/`cancelled`/`refused`/`failed` with a closed reason and frames on failure);
  never a credential, capability, URL or server name.
- **Production MCP OAuth is centrally owned and relayed.** The shared Settings/connection
  composition described in ADR-0181 owns discovery, sign-in, refresh and encrypted custody for
  both Chat and Coding Workbench. Native runs receive only a run/server-bound relay capability;
  their `mcp.servers` configuration disables native OAuth. Successful sign-in and sign-out rotate
  a durable server credential epoch, invalidating old relays, catalogs and disclosure authority.
  The Workbench opens the central MCP settings to manage sign-in. No external OAuth credential
  is seeded into or harvested from a managed production run.
  The standalone native OAuth adapter and its real-executable proofs remain for explicit legacy
  compatibility without the shared composition. That adapter validates the operator's expected
  issuer, PKCE, resource, public client, unique request parameters and a plain loopback callback;
  its separate credential-seeding/scrubbing and retention guards still apply. These legacy
  proofs do not establish acceptance of the central OAuth browser workflow.
- **The plan tool is on (#3897, parity row T19, owner decision of 2026-10-24).** The pinned 2.1.4
  producer registers its plan tool `todowrite` only under `experimental.todo` (off by default in
  standalone), so a native run used to show no plan card. `createNativeOpenCodeV2Config` sets the
  switch on the native profile. The policy classifies the `todowrite` action as a read in every
  mode, Ask for approval included, and the V2 history projects its completed part as the plan
  snapshot, never as tool activity. Proven on the original executable
  (`opencodeNativeQualification.real.test.ts`): the production launch offers the tool and an update
  in Ask for approval is allowed without a human and projects as the plan; the control without the
  switch is offered no plan tool and the call is the producer's own error.
- **Built-in formatters follow the launch mode, and only Full access runs them (#3897, parity row
  C07).** The pinned 2.1.4 producer runs a built-in formatter (`gofmt`, `rustfmt`, `shfmt`,
  `prettier`, ...) after its own `write` and `edit` as a plain child process of the runtime. No
  permission is evaluated for it, so the policy hook sees the edit and never the formatter, and it
  runs only when the configuration says `formatter: true`; its own default is off. Keiko therefore
  writes the setting explicitly on both configuration layers, never inherited, from the launch
  mode (`openCodeNativeFormatterDisposition`): Full access enables it; Supervised workspace and
  Ask for approval turn it off; an absent or unrecognized mode fails closed to off. Supervised
  workspace is off for the same reason the egress rule above exists: the setting is bound when the
  tree launches, and a resume may narrow Supervised workspace to Ask for approval in place, so an
  enabled formatter could outlive the mode that allowed it. A Full access tree cannot be narrowed
  in place at all, so an enabled formatter never does. A unit test pins that coupling (a mode that
  enables the formatter must be one whose in-place narrowing is refused) so widening either rule
  breaks the other. Formatting in Supervised workspace needs a narrowing the runtime can apply in
  place and is not implemented. Proven against the staged original executable under the real
  native Seatbelt wrapper (`opencodeNativeFormatter.real.test.ts`): in Full access a native
  `write` and a native `edit` are each followed by the PATH-resolved `gofmt` built-in with no
  permission asked for it; in Ask for approval and Supervised workspace the same calls land
  verbatim; without the key the producer runs no formatter even in Full access. In Full access the
  setting carries the user's global and the project's own `formatter` configuration (#3900 AC4,
  `opencodeConfigDocuments.ts`), merged in the producer's order (a boolean replaces, an object
  merges entry by entry and its environment key by key) and re-validated by Keiko: `disabled`,
  `command` (argv with `$FILE`), `environment` and `extensions` only, bounded, and no value with a
  `{env:...}` or `{file:...}` placeholder, which the producer would substitute with the run's own
  capability or a file the run may not open; without configuration the built-ins run (`true`).
  Every other mode stays `false` whatever is configured. The producer resolves `prettier`, `oxfmt`
  and `biome` through its own package manager into its package cache, never the repository's
  `node_modules/.bin`. Below Full access that package manager stays offline
  (`npm_config_offline`); a Full access run keeps its internet egress, so the package manager
  reaches its registry as standalone does, with one bounded retry so an unreachable registry
  fails promptly (startup unchanged against a blackholed registry). Formatters that resolve a
  binary on the launcher's `PATH` run when it is installed and readable inside the kernel read
  allowlist's toolchain roots. `pint` runs the repository's `./vendor/bin/pint` (read from the
  bundle, not exercised) and so is covered by the same Full-access-only rule. Real binary: a
  project-configured custom formatter runs and a project-disabled built-in does not in Full access,
  neither runs in Ask or Supervised, and the producer installs prettier from a loopback registry
  and runs it (red with the old offline switch); with loopback-only egress a repository's own
  prettier is still never executed. Each prepared native run records its decision body-free as
  `coding-runtime.native-formatter.bound` (closed `disposition` and `launchMode`, plus the
  configured and refused entry counts).
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
  permission. The workspace-root `AGENTS.md` still reaches the model as Keiko's own bounded,
  untrusted copy in the producer's global instruction slot (ADR-0137 D1), and the producer's
  `read` loads the nested `AGENTS.md` files between its target and the workspace root. Keiko's
  generated plugins load from the private discovery directory, which the switch does not touch.
  The restriction stands for what is executable or authoritative: the project `opencode.json`,
  every plugin, the project's own instruction discovery and `instructions` sources, `.claude/`
  and MCP configuration do not load as a layer. Keiko itself admits what is data in them: the
  Markdown items and the `opencode.json` agents and commands below, and plugins only through the
  operator's digest-pinned registry (below), never through repository text.
- **Markdown-only repository items are admitted one by one as sanitized copies (#3903).** The
  native profile (only; the mapped profiles keep their behaviour) reads the workspace's custom
  agents (`.opencode/agents/*.md`, `.opencode/agent/*.md`), custom commands
  (`.opencode/commands/*.md`, `.opencode/command/*.md`) and skills
  (`.opencode/skills/<name>/SKILL.md`, `.opencode/skill/<name>/SKILL.md`,
  `.agents/skills/<name>/SKILL.md`) and writes a re-rendered copy of each admitted one into the
  run's private discovery directory, the configuration directory the producer reads beside Keiko's
  generated plugins: `agents/<name>.md`, `commands/<name>.md`, `skills/<name>/SKILL.md`. The copies
  are written before the first launch (exclusive create, mode 0600, inside the directory the
  Seatbelt profile already protects from every descendant); the producer loads them when the
  location is first used. `codingRuntimeRepositoryItems.ts` owns the reading and the evidence,
  `codingRuntimeRepositoryItemSanitizer.ts` the pure validation.
  - **One reader.** Every file is read through the secure workspace read helper the repository
    instructions use (never a second file reader), and the directories through the same helper's
    native listing, only while the run's own workspace is still the active one (checked around
    every call; a switch admits nothing). Bounds: 16 agents, 32 commands and 16 skills, 32 / 48 /
    32 candidates considered, 512 directory entries, 32 KiB per file and 256 KiB for the copies together,
    descriptions of 256 (agent), 200 (command, the `/` menu contract) and 512 (skill) characters,
    and a 20 second deadline joined with the run's own cancellation. A name must match
    `^[a-z][a-z0-9]*(-[a-z0-9]+)*$` within 48 characters, is the file or directory name, and may not
    be a built-in agent, command or skill (`build`, `plan`, `general`, `explore`, `compaction`,
    `title`, `summary`, `init`, `review`, `opencode`, `report`, `default`, `all`), nor start with
    `keiko`; a file of such a name would replace the built-in. Hidden entries, symbolic links,
    loose files beside skill directories, nested directories and a repeated name (the plural
    directory wins) are not admitted.
  - **Nothing of the original frontmatter is forwarded.** The frontmatter is parsed by a closed
    subset of YAML (top-level `key: scalar`, quoted and block scalars, indented continuation), a
    per-kind allowlist is read by typed readers, and the copy's frontmatter is rendered anew:
    agents keep `description`, `mode` (`subagent` or `primary`; absent is admitted as `subagent`)
    and bounded numeric `temperature` (at most 2) and `top_p` (at most 1), and `model` only as
    the gateway-bound model it names (`keiko-runtime/<id>` of a model the Model Gateway serves,
    #3903 AC1; any other model is dropped and counted); commands keep `description`, `agent` and
    `subagent` (its deprecated alias `subtask` is accepted); skills keep `name` (the directory
    name; a different one is refused) and a required `description`. `permission(s)`, `tools`,
    `provider`, `mcp`, `plugin(s)`, `disabled`, `request` and every other key are dropped and only
    counted. A
    shape the parser does not understand (a quoted key, a duplicate key, a flow collection, an
    anchor, a tag) is refused, never guessed at. Control, bidirectional and zero-width characters
    anywhere in the file are refused. The body is untrusted prose (a system prompt, a template, a
    skill) that grants no authority, like the workspace `AGENTS.md`.
  - **Command templates.** A command may name only an agent admitted as a subagent in the same
    pass. The producer's command code switches the session onto a named primary agent (control
    below), behind Keiko's record of the session's agent, so a command could take a Plan session
    off its read-only agent; a subagent instead runs the command in a child session under that
    agent, and `subagent: true` runs it in a child session under the session's own agent (Plan
    stays Plan). A template that contains a bang-backtick block, or can form one at a placeholder
    boundary (`!` before `$ARGUMENTS` or `$1`, a placeholder before a backtick or another
    placeholder), is refused: the producer runs every such block in the project directory outside
    the permission hook. `$ARGUMENTS`, `$1`.. and `@path` text are inert (the `@path` stays text;
    nothing is read for it) and are admitted. The same producer behaviour makes the argument text
    of any command dangerous, built-ins included, because it substitutes the text into the
    template and then expands the blocks, so `OpenCodeV2HttpClient.command` refuses a text that
    contains a bang-backtick marker before any byte is sent (`not-submitted`).
  - **Proven against the staged 2.1.4 executable**
    (`opencodeNativeRepositoryItems.real.test.ts`, under the real native Seatbelt wrapper with the
    production launch profile): the admitted commands, agents and skill list; the hostile agent
    (model, permission, tools, MCP and plugin keys) lists with no model route and exactly the
    rules a plain agent has, while the same file copied unsanitized registers `evil-provider/evil-model`
    and an extra rule (control); a file named `build.md` does not replace the default agent; the
    skill's sibling script is never copied and its shell-looking text stays literal; a hostile
    project (plugin canary, provider override) neither runs nor moves the model route; the
    shell-substituting template, copied unsanitized, writes its canary with the policy hook never
    asked (control); a command naming a primary agent moves the session onto it (control); a
    `subagent: true` command under Plan keeps Plan; and the policy hook is asked for the `skill`
    action.
  - **Authority.** An admitted agent has the producer's default rules for a plain agent (allow by
    default, `.env` reads ask, `browser` denied) plus whatever `keiko.native-policy` decides for
    every action by mode: no key that could widen it survives. Its own restrictions do survive:
    the copy keeps every `deny` rule of its V1 `permission` map and of its canonical V2
    `permissions` rule array (block items of `action`, `resource` and `effect`), re-rendered from a
    closed grammar (for the map, an action with a value or with one level of quoted or plain
    patterns), and drops
    `allow` and `ask`, because the runtime lets a later rule override an earlier one and a
    forwarded `allow` could undo one of Keiko's own denials before the hook is asked. Dropping an
    `allow` exception only narrows the agent. A permission map or rule array outside that grammar
    (a flow list among them), or a
    `tools` switch that turns a tool off, refuses the agent (`restriction-unrepresentable`)
    instead of silently losing the restriction. The original executable proves it: the guarded
    agent's write is refused before the hook is asked, while an ordinary admitted agent's write is
    asked and lands (control: without the kept rule the same write lands). It is not Plan: like
    the built-in `general`, a custom subagent can edit where the mode allows, and unlike `general`
    it can launch subagents of its own and ask questions; the session tree is bounded (64 children) and
    the envelope's tool budget still counts every call. A skill's base directory is the private
    discovery directory, so relative resources named in a skill resolve there and do not exist;
    the model reads them from the workspace by their path with the governed read tool.
  - **`.claude/skills`, by a named exception (owner decision of 2026-10-24).** `.claude` stays a
    tool-state path of the always-on deny list (it can hold settings, transcripts and credentials).
    The admission alone names one exception on its reads (`denyListException:
    "repository-claude-skill"`), and `isRepositoryClaudeSkillPath` in `keiko-workspace` covers
    exactly `.claude/skills`, a skill directory's name in that listing and its
    `.claude/skills/<name>/SKILL.md`, case included, with a plain lowercase name the deny list does
    not match. `isDenied` itself is unchanged, every other caller and every other path under
    `.claude` stays denied, and the skill is sanitized like any other; it comes after the
    `.opencode` and `.agents` skill directories, so an earlier name wins.
  - **Not admitted, with the reason.** Everything else under `.claude`. Skill sibling files, nested
    agent and command names (`team/reviewer`), `mode: all`, the producer's `steps`, `hidden`,
    `color` and `request` keys, global directories (the private `HOME` is empty), remote skill
    indexes stay out; MCP servers come from the operator's registry (below).
  - **Operator switch and evidence.** `KEIKO_CODING_REPOSITORY_ITEMS_ENABLED` is on by default;
    `true` keeps it, and `false` or any other value disables it (an unrecognised value fails
    closed to off). Each native launch records one body-free
    `coding-runtime.repository-items.admitted` line under the run's correlation id: `disabled`,
    `unavailable` (no secure read, no listing, a workspace switch), `empty`, `completed` or
    `failed` (cancelled, deadline, write failure, exception, at `warn` with the closed error kind
    and the dist-anchored frames), the admitted and refused counts per kind, the closed refusal
    reasons present, directory failures, the stripped authority-bearing and other key counts, the
    copies' byte total and a SHA-256 over them, never a name, a path or a body. The same line
    counts the project configuration files read and refused (`configFileCount`,
    `configRefusedCount`).
  - **The project `opencode.json` contributes its agents and commands (#3903 AC2).** Keiko reads
    `opencode.json` / `opencode.jsonc` and their `.opencode/` variants through the same secure read.
    JSONC accepts comments and trailing commas through the existing TypeScript configuration parser;
    any diagnostic refuses the whole file as `config-malformed`, never admitting a partial parse.
    Both known filename extensions accept the producer's comments and trailing commas. Keiko turns each entry of the
    current `agents` (prompt in `system`) and `commands` sections, and of the earlier `agent`
    (prompt in `prompt`) and `command` sections the producer still migrates, into the same
    Markdown item: JSON-quoted scalar frontmatter and the prompt or template as its body, which the
    sanitizer above then judges like any file. Every other top-level key (`plugins`, `providers`,
    `permissions`, `mcp`, `model`, `instructions`, `references`, ...) and every non-scalar entry
    key is dropped and counted. An agent entry carrying `permission`, `permissions` or `tools` is
    refused (`restriction-unrepresentable`): its restrictions exist only in a shape the Markdown
    renderer does not carry, and an agent must never be admitted less restricted than written. A
    Markdown item wins over a configuration entry of the same name; the configuration entry is
    refused as a duplicate. The real-binary suite proves the configuration's agents and commands
    list and run while none of its plugins, providers or MCP servers load.
    Global documents share that parser and the existing owner-private descriptor reader. Both
    admitted producers (2.0.10 and 2.1.4) merge `opencode.json` then `opencode.jsonc`; neither
    loads `config.json`. Diagnostics, partial parses and non-standard object prototypes at any
    depth refuse the complete document.
- **Remote skill sources are pulled by Keiko, not by the runtime (#3903 AC3, parity row T17).** The
  producer's `skills` setting pulls `<url>/index.json` and each listed skill's files from the same
  origin over its own egress and loads them unsanitized; that setting stays Keiko's. Instead
  `opencodeRemoteSkills.ts` pulls the sources the operator names in the owner-private
  `<stateDir>/opencode-skill-sources.json` (`{ "schemaVersion": 1, "sources": [{ "url" }] }`, at most
  4 `https` sources without credentials, query or fragment), only for a run launched in Full access,
  through Keiko's egress configuration with no redirect and loopback and private targets refused.
  It reads only the index (64 KiB, 64 entries) and each skill's `SKILL.md` (32 KiB), passes every one
  through the repository skill sanitizer, and writes at most 16 copies to the private `skill/`
  discovery directory beside the repository's `skills/`, where the producer's own `skill` tool lists
  and loads them; sibling files are never copied and a repository skill keeps its name. Each prepare
  first removes the previous pull. Each fetch ends at 10 seconds and one admission, every source
  together, at 30, so a run never waits longer for an unreachable network; a source that does not
  answer is `source-failed` and the run starts with the repository's own skills (#3907 AC10). The
  gateway request ends a DNS lookup no resolver answers with the request's own deadline or
  cancellation, because the resolver itself takes no signal; a cancelled request starts no lookup.
  The lookup it gave up on cannot be cancelled either, so requests for one host share the lookup in
  flight, and while two lookups nobody waits for are pending, a lookup for another host fails at
  once as a temporary resolver failure (`EAI_AGAIN`).
  Evidence: `coding-runtime.remote-skills.admitted` (a registry
  line or one line per source with counts, closed refusal reasons and SHA-256 digests of the source
  and of the copies; never a URL, a name or a body). The staged 2.1.4 executable lists a pulled
  skill beside the repository's own, sanitized, and pulls nothing itself.
- **Plugins are operator code, admitted by digest for Full access only (#3903 AC2).** A plugin is a
  module the producer imports into its own process, so no repository text can register one. The
  operator registers local plugins in the owner-private `<stateDir>/opencode-plugins.json`
  (`opencodeOperatorPlugins.ts`), read with the same no-follow, owner-checked reader as the MCP
  registry (`ownerPrivateStateFile.ts`): `{ "schemaVersion": 1, "plugins": [{ "name", "workspacePath"
  | "path", "sha256" }] }`, at most 8, a name of `^[a-z0-9][a-z0-9-]{0,47}$` not starting with
  `keiko`, exactly one source (a normalized workspace-relative module read through the run's exact workspace read, a normalized absolute module the operator installed, or an npm package the operator installed into an absolute directory with `npm install --prefix`, named with its `entry` module), a `.js`, `.mjs` or `.ts` module of at most 512 KiB and the lowercase SHA-256 of its exact bytes; for a package the SHA-256 of the `shasum -a 256` listing of every regular file of the tree in byte order of its path (`find . -type f -print0 | LC_ALL=C sort -z | xargs -0 shasum -a 256 | shasum -a 256`; at most 4,096 files, 32 MiB), hashed from the same bytes it copies. Anything else refuses the
  whole registry. At each native prepare Keiko first removes what an earlier admission wrote, then
  admits only when the run's launch mode is Full access (`autonomous-delivery`): per-action
  approval cannot bind code that runs inside the producer, while Full access is the mode whose
  effects already proceed inside the envelope without a per-action decision. A plugin whose bytes
  no longer match, or that cannot be read, is refused; the others still load. An admitted file is
  copied (exclusive create, 0600) to `operator-plugins/` in the run's private configuration
  directory, outside the producer's `plugin`/`plugins` discovery and inside the root the kernel
  keeps read-only to the run, and the producer discovers Keiko's generated
  `plugins/admitted-<name>.ts` wrapper. The wrapper hands the plugin the producer's context with one
  change: its permission hooks run on a structured copy of the event and may only narrow the
  effect (allow, ask, deny), so neither the order in which the producer runs hooks nor a lazy
  registration lets a plugin widen Keiko's decision or alter the resources Keiko's own hook judges;
  every other permission hook, the rest of the permission API and the `effect` plugin form (which
  would reach the producer's services directly) are refused. Beyond permissions an admitted plugin
  is trusted operator code: the kernel boundary and Keiko's server-side authority (the delivery
  redemption, the tool facade's capability) bind it like the runtime itself, and the operator who
  registers it accepts that. Keiko's generated plugins stay required: a plugin that claims one of
  their identities fails the run's readiness. A plugin must be one self-contained module, since its
  own relative imports do not travel with the copy. A failure to clear an earlier admission fails
  the prepare, because a copy left behind would load in a run that never admitted it. Each prepare
  records one body-free `coding-runtime.operator-plugins.admitted` line (`absent`,
  `registry-refused` with its closed reason, `mode-restricted`, `admitted` or `failed`, the
  registered, admitted and refused counts, the closed per-plugin refusal reasons and a SHA-256 over
  the admitted names and digests, never a name, path or byte). The staged 2.1.4 executable proves
  it under the real native Seatbelt wrapper (`opencodeNativeRepositoryItems.real.test.ts`): a
  registered plugin is active at Full access, an approve-everything hook neither widens Keiko's
  denial of a shell command nor empties the resources Keiko judges, a narrowing hook refuses a
  shell command Keiko allows (control: an allowed command runs), a Supervised run and changed
  bytes load none, and a plugin claiming `keiko.native-policy` fails readiness, and an installed npm package whose plugin id comes from its own dependency is active (the dependency resolves inside the copied tree). `opencode plugin add` stays refused: it installs from the registry, which leaves the machine; the operator installs the package.
- **The server-owned binding rides the highest layer.** The profile also passes the single
  provider, model, `default_agent`, `update`/`share` switches, the built-in `formatter` setting
  (above) and the mode-independent permission floor as `OPENCODE_CONFIG_CONTENT`, a secret-free
  subset of the private file that holds only
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
  `coding-runtime.agent.selected` (run, new and previous agent; a custom agent as `custom`).
  **Custom primary agents (#3903 AC1).** On the native profile a follow-up may also name a custom
  primary agent: a repository or configured agent whose mode is `primary` (or `all`). The contract
  admits a well-formed name that no built-in, built-in subagent (`general`, `explore`) or hidden
  agent (`compaction`, `title`, `summary`) carries in any spelling; a start still names a
  built-in only, because only a live run lists its custom agents. Before the switch the composition
  confirms the name against the runtime's own listing (`GET /api/agent`, primary or all-mode,
  visible); an unlisted name, a subagent or a failed listing refuses the turn with no switch and
  no prompt. The commands channel carries the run's custom primary agents (`primaryAgents`), and
  the composer's agent switch offers them beside Build and Plan on a paused native run. They work
  within the run's mode like every agent. **Per-agent models (#3903 AC1, owner decision
  2026-10-25).** The primary agent keeps the run's model; any agent may name its own model, as in
  standalone OpenCode (a large orchestrator, small subagents), but only a model the Model Gateway
  serves: the one gateway-bound provider declares the gateway's coding-capable models beside the
  run's alias (`opencodeNativeAgentModels.ts`), the server-owned `agents` setting carries the
  `agents`/`agent` overrides of the user's global and the project's configuration that name one
  of them, an agent file keeps a `model` that names one, and every other model is refused and
  counted (the agent keeps the run's model). The gateway resolves such a request against that
  model's own profile (bounds, accounting, provider) under the run's capability and prompt budget;
  the run's own upstream id and any model it does not serve stay refused on the runtime lane.
  `coding-runtime.agent-models.bound` records the offered model and configured/refused override
  counts. The browser learns what it may
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
  single-use request id). A delivery is also safe to retry. Its operator request id is bound to the
  producer's supported `Session.Message.ID` (the prompt body's `id`, pattern `^msg_` in the pinned
  schema): the producer stores one input per id and answers a repeated post of it with the receipt
  it already holds, so a retry after a lost acknowledgement is the same input, not a second one.
  Keiko mints the id once per request, in the producer's own ascending layout
  (`opencodeNativeMessageId.ts`: `msg_`, twelve hex digits of `milliseconds * 0x1000 + counter`,
  fourteen base-62 characters, strictly ascending within the process), and the run port retains it
  beside a digest of the message and a one-line preview of it (at most 32 per run; only an acknowledged entry is
  forgotten for room, never an unresolved one, whose message the producer may hold: while all 32 are
  unresolved a new request is refused unsent with `delivery-unresolved-limit`, PR #4064 review), so a retry of the same request resends it. The client reconciles the producer's receipt against the
  id it sent. A failed post is classified by what it proves about the producer: refused before any
  byte left, or answered with a declared 4xx status, the producer holds nothing and the id is
  forgotten, unless the failing attempt itself reused an id an earlier attempt may have stored;
  anything else (a connection lost or timed out after the request was sent, an unreadable
  acknowledgement, an undeclared 5xx) is possibly accepted and leaves the id bound. Either way the
  dispatcher frees the reservation, because the delivery was not committed, and the same request may
  be retried; a replay after the known success, a stale revision, a stopped run and a settled turn
  are refused exactly as before and send nothing. A request id that returns with another message is
  refused (`request-conflict`) rather than answered with the receipt of the first, and a receipt
  that names another id is committed as accepted but unreconciled and never retried. A retry that
  arrives after the turn settled is refused with no way to tell whether the first attempt was
  applied; the log shows its `delivery-unconfirmed` attempt. The pinned 2.1.4 behaviour is proven against the original executable
  (`opencodeNativePromptInputs.real.test.ts`): `steer` reaches the model with the running turn's
  next step and `queue` after its final answer, both inside one execution, so the one settlement
  Keiko waits for covers them, and a lost acknowledgement followed by a retry of the same request
  leaves one productive input, for `queue` and for a `steer` the running turn already consumed
  (without the id the same retry stores two, which the file's control shows); a delivery sent to an
  idle session starts an execution nothing in Keiko would settle, which is why admission requires a
  turn in flight. A consumed id posted again to an idle session starts one too, so a retry is sent
  only while the turn is in flight; a producer that settles between Keiko's check and the post is
  the narrow window every delivery already has. Both inputs are offered by
  the native profile only (`openCodePromptInputs`, reported as `promptInputs` in the readiness
  read) and refused as `invalid-intent` elsewhere and for a Codex run, exactly like a `plan`
  request. A reference must resolve, through the descriptor-bound workspace read, to a plain UTF-8
  text file inside the run's canonical workspace root: no `..`, no symbolic link (the real path is
  judged again), no hard link, no sensitive path (`isDenied`, the list the kernel boundary shares),
  at most 64 KiB per file, 192 KiB per prompt and 1 MiB per run (the runtime embeds the bytes in
  the session history that Keiko reads back whole). The first violation refuses the whole prompt
  before anything is sent. A prompt's files count against the run when it is sent, not when its
  acknowledgement arrives: once the request has left, the producer may hold them (PR #4064 review:
  six queued prompts whose answers were lost otherwise passed the 1 MiB bound). The charge is
  returned only when the failure proves the producer holds nothing (its first and only attempt,
  under a fresh id, was refused before it was taken); a retry of the same native id charges nothing
  again, and a prompt that no longer fits because another admitted prompt was sent first is refused
  unsent with `references-run-budget`. Turn prompts, slash commands and deliveries share this
  rule (`reservePromptInputs` / `releasePromptInputs`). The attachment is the runtime's `files` entry: the bytes that descriptor
  read admitted, inline as a `data:text/plain;base64,` URI, and the file name. An image (`.png`,
  `.jpg`, `.jpeg`, `.gif`, `.webp`) or PDF reference is attached the same way under its own type
  (#3906 AC1), but only when the run's model declares that input (the same `imageInput` /
  `documentInput` the launch profile declares to the runtime) and only when the descriptor-read
  bytes carry the medium's own signature; otherwise the prompt is refused with
  `reference-media-unsupported` or `reference-not-media`. One medium may hold 512 KiB
  (`OPENCODE_PROMPT_MEDIA_MAX_BYTES`), counts against the run's 1 MiB budget and not against the
  prompt's text bound, and the original runtime hands it to the model as its own user-message
  `image_url` or `file` part (`opencodeNativeMediaInput.real.test.ts`). A `file://` URI is
  never sent (the client refuses it before a byte leaves), because the runtime would reopen the
  path after Keiko's check and a hard link swapped in between would reach the model instead (#3897
  review; the real-binary control replaces the path after admission). The typed text stays the visible message and the file content stays
  out of the timeline, Coding History and logs. Evidence is the body-free
  `coding-runtime.prompt-inputs.settled` line: the run, `accepted` or `refused`, the closed
  delivery, the reference count, and the attached bytes or the closed refusal reason. A delivery
  also names its operator request id and how its native message id was handled (`inputBinding`:
  `bound` minted for this request, `reused` resent from an earlier unconfirmed attempt,
  `unreconciled` accepted under another id); a delivery that failed after admission is `refused`
  with `delivery-refused` (the producer holds nothing) or `delivery-unconfirmed` (it may hold the
  message), the closed error kind and `reservedBytes` (what its files still hold of the run's
  budget: zero once they provably never arrived), so a lost acknowledgement and the retry that
  resolved it join on the request id. Never a path, name, text or message id. The composer offers Send now (Enter) and Queue (Ctrl or Cmd+Enter) while a
  turn runs and the `@` picker (the Files search over the run's workspace, no second index) while
  a run runs or is paused and, for a new task, over the workspace the run will start from.
  **The first prompt takes the same references (S15).** A start may carry `references` (the same
  closed `{ path }` entries and bounds as a follow-up's: at most 16, no absolute path, URI or link,
  sensitive paths refused). The task workspace does not exist before the run is minted, so nothing is
  resolved at the request: the launch refuses, before the one-use confirmation is consumed or any run
  exists, a runtime that cannot take them (the mapped profiles and a Codex run, `invalid-intent`),
  and the paths are resolved against the run's own canonical workspace root when its first turn is
  dispatched, through the same `admitPromptInputs` as a follow-up's. A reference that is refused
  refuses the start with the existing closed reason: the run that was minted for it is stopped and
  settles `failed` with `invalid-intent`, and the turn is never sent without the files the operator
  named (the diagnostic stage is `initial-turn-inputs-refused`; the `coding-runtime.prompt-inputs.settled`
  line carries the closed refusal reason). The composer enables the `@` picker for a new task when
  the readiness read says `references`, searching the active task workspace when it belongs to the
  selected repository and otherwise the selected repository's root; a path the run's workspace does
  not hold is refused at the dispatch like any other.
- **The messages still waiting for the running turn are listed, can be cancelled, and a queued one can
  be sent now (S07).** The runtime keeps every accepted input in the session's inbox until it hands it
  to the model, and the protocol surface admits its three operations (`GET
  /api/session/{sessionID}/inbox`, `DELETE .../inbox/{inboxID}`, `PATCH .../inbox/{inboxID}` with
  `{ delivery }`; 24 operations on 22 paths, the 2.1.4 and 2.0.10 digests re-pinned). Proven against
  the original executable (`opencodeNativePromptInputs.real.test.ts`): the listing is in arrival order;
  every steered message reaches the model together with the next step, in arrival order, and a queued
  one after the turn's final answer, so a promoted message joins the next step instead; a withdrawal
  is answered 204 whether the runtime removed the input or had already given it to the model, and a
  change of an input it no longer holds as pending is a 409; and pending messages survive an
  interrupt and reach the model with the next prompt. Keiko therefore shows and changes only the
  operator's own messages: an entry is listed only when its id is one the run's delivery ledger minted
  (the ledger keeps the operator's text as a one-line preview, at most 200 characters, control and
  text-reordering code points removed; the runtime's payload is never read), so another client's input,
  a synthetic one or a forged id is invisible and refused (`unknown-item`). `GET
  /runs/:runId/inbox` is an authenticated, revision-free channel read (ADR-0141): `items` of `{ itemId,
  delivery, preview }` in the order the model will receive them (steered first, queued after, each in
  arrival order), absent when the run offers none, a profile takes no delivery or no turn is running;
  an unpaired caller gets the constant projection. `POST /runs/:runId/inbox` takes `{ requestId,
  expectedRevision, action: "cancel" | "promote", itemId }` and is admitted like an undo: a running
  run only (a paused run has no turn to hold a message), the revision consumed once, the request id
  single-use, the live authority revalidated by the dispatcher, no turn started, replaced or settled.
  A message the runtime already took is the truthful success `already-delivered` and one Keiko
  withdrew itself `already-cancelled`, never an error; a cancel is called one only after the newest
  history shows the message was not delivered in the instant between the read and the withdrawal, and
  a conflict on a change is believed only when the inbox no longer lists the message. The body-free
  `coding-runtime.inbox.action` line records the run, the closed action (`list`, `cancel`, `promote`,
  `withdraw`), the closed outcome and counts, with the error kind, frames and causes of a failure; a
  coordinator transport failure is `coding-runtime.inbox.dispatch-failed`. Never a message, preview or
  id. Because the runtime keeps pending messages through an interrupt, the run port's abort withdraws
  every message Keiko delivered that is still pending once the interrupt settled (`withdraw`), so a
  stopped or undone turn cannot hand them to the next prompt; a failed withdrawal is logged and does
  not fail the stop. The Workbench lists the messages above the composer with Cancel and, for a queued
  one, Send now, and refreshes on the run's revision and on the conversation gaining a message (no
  polling); a failed read is a retryable error, never an empty list.
- **A turn may run as one of the runtime's slash commands (C02).** The pinned 2.1.4 producer lists its
  commands (`GET /api/command`, `command.list`: `init`, guided AGENTS.md setup, and `review`, review
  of the changes, defaulting to the uncommitted ones) and runs one as a turn (`POST
  /api/session/{sessionID}/command`, `session.command`, body `{ name, text, files?, agents?, skills?,
  delivery? }`, 204; `CommandNotFoundError` is a 404, `CommandExecutionError` a 500). Both operations
  are admitted in the protocol surface (21 operations then, 23 with the session fork and removal of
  S02 and S03 below; the structural digest pins and the captured fixture moved with them, and the original executable's live document projects to the new digest).
  A command is a server-authored prompt template: it is untrusted intent like any task text, grants
  nothing, and every effect it causes passes the native policy of the run's mode. The producer
  registers its built-ins a moment after the instance boots, so the listing is empty until then; the
  admission treats an absent name as unknown. A start or a follow-up may carry `command: { name }`
  (a bounded name, `isCodingWorkbenchCommandName`) and the text after the command in `taskIntent`,
  which may then be empty and only then; a command cannot be a `delivery` and a start cannot combine
  one with an issue reference. The native profile alone offers commands (`promptInputs.commands` of the
  readiness read; absent reads false), and a start or follow-up that names one elsewhere is refused
  like a `plan` request. The dispatcher admits a command like any prompt input and then asks the run's
  runtime (`GET /api/command`, fresh) whether it lists the name, all ahead of any reservation, so an
  unknown name begins nothing and leaves the request id and revision usable; an unreadable listing
  proves nothing about the name and refuses it as well (`command-unavailable`). The dispatch is then the
  ordinary one (the same orchestrator, operation coordinator, run port, revision, single-use request
  id, replacement of a paused turn, turn lifecycle and history projection), with `session.command`
  posted in place of `prompt`. The body has no message id, so the delivery's native-message-id ledger
  does not apply: a command turn is a turn like a prompt turn, whose acknowledgement is the
  runtime's settlement, and a failed post fails the turn it started (`command-refused`), never
  resending it. Sent to a running turn the producer takes the command into that execution at its next
  step like a steered message, which is why Keiko dispatches a command only as the start of a turn.
  The command body has no field to hide a context in, so a command turn carries no initial context
  (repository instructions, memory, history, issue): the orchestrator builds none for a command
  start, and the model reads what it needs with its own governed tools. The producer stores the
  expanded template as the turn's user message and marks no command on it, so the run's command
  presentation is armed with `/<name> <text>` just before the post and the history projection
  presents the first user message it had not shown before by that text, in the timeline and in
  Coding History, never the template. `GET /runs/:runId/commands` (authenticated; an unpaired
  caller receives the constant `{ session: "unpaired" }` before any run resolution, ADR-0141) gives
  the Workbench's `/` menu the names and one-line descriptions the runtime lists, bounded and
  contract-valid (at most 64, duplicate-free, descriptions the contract refuses dropped from their
  entry); absent `commands` means the run offers none. A new task, which has no runtime to list
  yet, shows the pinned built-ins (`CODING_WORKBENCH_BUILT_IN_COMMAND_NAMES`); the original-runtime
  proof fails if the producer lists anything else. A native run's own listing also carries the
  workspace's admitted custom commands ("Markdown-only repository items", #3903); they reach the
  `/` menu only after the runtime lists them. Evidence is body-free: the
  `coding-runtime.prompt-inputs.settled` line names a built-in command (`init`, `review`) and any other
  only by the SHA-256 of its name (`command`, `commandDigest`) with the UTF-8 size of the text after
  it (`commandArgumentBytes`) and the closed refusal reasons `commands-unsupported`,
  `command-unknown`, `command-unavailable` and `command-refused`; each listing is one
  `coding-runtime.commands.listed` line (outcome and counts, with the closed error kind, frames and
  causes of a failed one). `opencodeNativePromptInputs.real.test.ts` proves, on the original
  executable, that `command.list` returns exactly the two built-ins, that `review` runs a turn whose
  model request carries the producer's template and ends idle, that the built-in templates
  substitute no shell command, and that a start's referenced file reaches its first model request.
- **A prompt may mention the runtime's subagents and skills (S15, #3906).** `GET /api/agent`
  (`agent.list`) and `GET /api/skill` (`skill.list`) join the admitted surface (28 operations; the
  structural digests moved and reproduce from the upstream, the live 2.1.4 and the live 2.0.10
  documents). For the run's workspace the client keeps only visible subagents (mode `subagent` or
  `all`, not hidden) by id and skills by id and name; an agent's system prompt and permissions and a
  skill's path and content never leave it. The listing rides the commands channel (`agents`,
  `skills`; absent means the run offers none), and a new task shows the pinned built-in subagents
  (`CODING_WORKBENCH_BUILT_IN_SUBAGENTS`: `general`, `explore`). A start, a follow-up and a steered
  or queued message may carry `mentions: { agents?: [{ name, mention? }], skills?: [{ id, mention? }]
  }` (at most 8 each, a bounded name, the half-open span of the typed token in the text sent), the
  native profile alone offering them (`promptInputs.mentions`). They travel as the prompt's or the
  command's own `agents` and `skills` attachments; a hidden initial context that leads the sent text
  moves every span by its length and separator. The pinned runtime stores any name it is given, so
  the dispatcher confirms every mention against the run's listing ahead of any reservation, for a
  turn and a delivery alike (`mention-unknown`, `mention-unavailable`, `mentions-unsupported`). The
  runtime answers the first read of a location that is still loading with an empty listing; its
  built-in subagents are always listed once it has loaded, so an empty agent listing is read again,
  at most six times 250 ms apart. A mention grants nothing: an `@agent` reaches the model as typed
  and the model may then launch that subagent under the run's policy, and a `$skill` puts the
  admitted SKILL.md ahead of the operator's text, literal. Evidence is body-free:
  `coding-runtime.prompt-inputs.settled` counts the mentions (`agentMentionCount`,
  `skillMentionCount`) and each listing is one `coding-runtime.mentions.listed` line (counts, or the
  closed error kind, frames and causes). `opencodeNativePromptInputs.real.test.ts` and
  `opencodeNativeRepositoryItems.real.test.ts` prove the mention, its refusal and the skill text on
  the original executable.
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
  executable shows it (`opencodeNativeMediaInput.real.test.ts`): a scripted `read` of a PNG puts
  one image part, byte for byte, in the next provider request and in the request the production
  route hands the gateway; a text-only declaration puts none.
- **A native `read` of a PDF reaches a model that declares document input (#3906 AC1).** The same
  path carries PDF documents. The provider model declares `pdf` input only when the admitted
  model's verified configuration declares `supportsDocumentInput` (the gateway readiness probe
  `document_input` sends exactly this part shape), carried as run metadata, and only on the native
  profile. `coding-sidecar-document-parts.ts` admits the producer's `file` part
  (`{ type: "file", file: { filename, file_data } }`, the shared `ChatMessageFileContentPart`)
  only as an inline `application/pdf` data URL that decodes to a `%PDF-` signature, at most
  `MAX_ATTACHMENT_BYTES`, at most 8 parts per request, on a user message; a filename that is not a
  plain name becomes `document.pdf`. Every other case is one of five closed
  `coding-sidecar.gateway.rejected` reasons (`document-part-invalid`, `document-mime-unsupported`,
  `document-part-too-large`, `document-count-exceeded`, `document-input-unsupported`). The Model
  Gateway forwards the part unchanged to OpenAI-compatible providers and charges it the same media
  allowance as an image (`documentCount` on `gateway.prompt.admission`, `documentCount` on
  `coding-sidecar.gateway.request-validated`); no document bytes, filename or URL enter a log. A
  model without document input never receives the part: the original runtime answers the `read`
  with its own unsupported-input result and the run continues text only. The original executable
  shows both (`opencodeNativeMediaInput.real.test.ts`).
- **A native run delivers through Keiko's delivery tools, never the shell (#3897, T12).**
  Standalone OpenCode commits and pushes through its shell. Keiko owns delivery (signed commits,
  bounded refs, ADR-0135; merge is never model-visible, ADR-0087; ADR-0138 D3), so the shell policy
  refuses Git writes and `gh pr`, `repo`, `release` and `api` in every mode, and its refusal names
  the way to deliver (`OPENCODE_NATIVE_DELIVERY_REFUSAL_MESSAGE`; the native guidance names the same
  tools). The native profile therefore registers exactly one group of Keiko tools, through the
  generated `keiko.native-delivery` plugin (`keiko_native_delivery.ts`): `keiko_git_status`,
  `keiko_git_diff`, `keiko_git_stage`, `keiko_git_commit`, `keiko_git_push`,
  `keiko_pull_request`, `keiko_git_execute`, `keiko_git_sync`, `keiko_ci_status` and
  `keiko_verification` (`opencodeNativeDeliveryTools.ts` holds the list once).
  `keiko_git_push` proposes pushing the run's verified commit to its own task branch on `origin`,
  any Git remote and no issue needed (ADR-0085 D1b); `keiko_pull_request` opens a draft pull request
  from that task branch on a verified GitHub origin, no issue needed (an accepted issue only links
  it), and otherwise returns `github-origin-required` or `remote-required` (ADR-0086 D13).
  `keiko_git_sync` fetches the upstream or fast-forwards the run's branch to it through the Git
  sync owner, under the owner's own mode decision (ADR-0138 D3 item 5); the shell's own fetch and
  pull stay refused (#3902 AC2). The managed worktree's Git directory is
  read-only to the run, so its own Git reads status, diff, log, show and blame but cannot write the
  index; `keiko_git_stage` with `unstage: true` gives staged paths back to the worktree through
  the same proposal, approval and redemption as staging (`unstage-<n>`, redeemed as
  `keiko_git_execute` kind `unstage`, bound to the head, base and staged-tree digest; the worktree
  keeps its bytes) (#3902 AC2). The proposal carries those three facts to the index effect, which
  checks them, together with the branch, inside the same index transaction as staging and again
  just before the reviewed index replaces the live one, with the run's authority at the swap; a
  change that lands after the review or an approval is never accepted as the effect's new snapshot
  (PR #4064 review). It is an option of the stage tool rather than a tool of its own, so the
  catalog's tool count and its performance case inventory stay unchanged. `keiko_verification` is
  a member only
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
- **A native check is the run's verification evidence (#3901).** Native tools execute outside the
  facade, so the governed verifier's ledger learned nothing from them and a native run that edited
  and never verified settled as succeeded. The native settlement owner now feeds the same ledger:
  a native `edit`, `write` or `patch` the runtime applied is the run's edit (`observeEditOutcome`),
  and a shell line the policy admitted as a project check (`openCodeNativeVerificationKind`: each
  simple command is a test, typecheck, lint or build invocation or a `cd`) is remembered with the
  edit revision and the admission observer the governed verifier captures at the same point. The
  runtime reports one exit status for the whole line, so only a line whose status is the check's
  own counts: simple commands joined by `&&` alone. `;`, `||`, a pipe, a background `&` or a second
  line lets a later command decide it (`npm test; cd .` exits zero after a failed test). The
  permission check receives the line already split into its commands, without the operators, so
  the history reads the finished part's whole command line (`exitStatusCheck`, body-free) and the
  settlement owner accepts the status only when that line names the admitted check. That exit
  status, which the producer reports as `metadata.exit` on a completed part (a non-zero exit is
  projected as a failed call, and the timeline shows the status, the number alone, as the call's
  `presentation.exitCode`, so a failed command says why it failed), becomes the same `verification-summarized` event, so the
  settlement's verification continuation,
  `verification-not-evidenced`, the human-refusal blocker and the Workbench's verification card
  treat both alike. A refused, backgrounded or unreported check proves nothing; a check admitted
  before the last edit cannot prove it. A line that only prints, lists or plans (`--help`,
  `--version`, `--listTests`, `--list`, `--collect-only`, `--no-run`, `--dry-run`, `make -n`,
  `npx vitest list`, ...) exits zero without checking anything and is no check. The plan agent's
  notes in the run's private plan directory, which the policy classifies as reads, are planning,
  not an edit a check must cover. A child session's workspace edit settles on the child, whose
  history the run does not read, so it counts as the run's edit from its admission
  (`unsettledEdit`, PR #4064 review follow-up). A shell command writes files no tool settlement
  reports: the runtime's own snapshot of each finished step names every workspace file that step
  changed (`snapshot.files`, `openCodeV2StepChanges`), so a step's changes that no native edit of
  the same step named count as the run's edit, once per step, when the history first shows it
  finished. A step of admitted project checks alone changed only what the checks write and counts
  nothing. A check whose admission preceded such a change cannot prove it, because the evidence
  binds the edit revision at admission. `coding-runtime.native-step.changed` records each weighed
  step body-free (outcome, file, uncovered and call counts; never a path). A passing line proves
  every check it ran, not only the one its status is named for (`openCodeNativeCreditedKinds`): an
  `&&` list exits zero only when each command in it did, so each check of the line counts, and so
  does each check a package script it runs chains with `&&`. The lab repository of the Keiko 1.3.1
  qualification documents `npm run check` (`npm run typecheck && npm run lint && npm test`); the
  model ran it after the governed verifier refused its type check, lint and test as
  `native-shell-required`, it passed, and the run still settled `verification-not-evidenced`
  because only its test counted. The task workspace's package.json is read once, at admission,
  through the guarded workspace reader; a body's other commands prove nothing, a `cd` in a body
  leaves its later scripts credited by name only, and a recursion bound stops scripts that run each
  other. A line that changes directory, a script invocation with options of its own
  (`--workspace`, `--prefix`) and a call that named its own `workdir` (`ownWorkdir`, from the
  finished part) credit no script body. A failing line is the named check's failure alone. Each
  credited check publishes its own `verification-summarized` event at the admitted edit revision,
  and `coding-runtime.verification` records it (`state: "credited"`, `verifierId`, `creditedBy`)
  or why the scripts could not be read (`credit-unavailable`, warn, frames and causes).
  The same line also proves the staged commit candidate (#3907 AC3). The ledger credit alone
  never reached the verified commit, so on macOS, where every governed check is
  `native-shell-required`, no native run could commit: each `keiko_git_commit` of the Keiko T6
  parity run settled `verification-failed` with zero failed checks. Admission now opens the
  verified-commit ticket the governed verifier opens before its run, and settlement completes it
  with the line's own result (its checks, exit code and duration; no output) through the same
  service. The ticket opens only for a fully staged, clean candidate and completes only when the
  staged tree is unchanged, so the proof covers exactly the content the check read; a failing line
  records a failed proof, and a line whose status another command decided completes nothing.
  `coding-runtime.verification` records the outcome (`state: "native-proof"`, `verifierId`,
  `stepCount`, `commitProof`, `commitProofReason`). A governed verification run that executed no
  step (each one skipped, denied or `native-shell-required`) says nothing about the candidate: it
  is kept for the run's check list, but no longer completes the ticket as a failed proof, which had
  replaced the passing native proof for the same staged tree and refused every later commit.
  The same parity run then showed a proven, approved commit settling `recovery-required` after
  its signed object already existed: a human who checks out the task branch locally gives the run
  that branch as its own base, and Git refuses a ref transaction that both verifies and updates one
  ref. The governed commit now guards such a branch by the update's own expected old value alone,
  which is equivalent only while the verified base and head agree; when they differ it fails closed
  before any ref update. A distinct base keeps its separate `verify` line in the same atomic
  transaction.
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
  cannot be moved away. A task workspace that is a linked worktree (every managed task workspace,
  created by `git worktree add`) keeps its Git metadata in the repository's common Git directory
  outside the workspace. The server names that directory as the filesystem capability's
  `gitMetadataReadRoots` (bound into the policy digest, outside the workspace and private state,
  native profile only) only after `inspectManagedGitdirIdentity` re-proved the reciprocal worktree
  registration, bound to the managed task's own repository; the kernel re-allows it read-only after
  the denied roots (a repository Keiko cloned may sit in its state directory) and before the
  credential names, so native `status`, `diff`, `log`, `show` and `blame` work while a write to it
  stays refused. Its ancestor directory nodes are readable like the workspace's (entry names only,
  never a file or a sibling subtree): once Git works, the original runtime resolves the repository's
  own working tree with `FileSystem.realPath`, which opens the node, and refused that resolution it
  answers every instance request with HTTP 500 (found by the customer-shape qualification). A forged, stale or misdirected `.git` file names nothing and is recorded as
  `unproven` on `coding-runtime.git-metadata.resolved` (#3897 review). A shell child is refused each of these by the real kernel
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
  denied at the resolved path. A hard link is not: it is the same file under a workspace path,
  which no pathname or realpath rule resolves (PR #4064 review). Native admission therefore
  refuses with `linked-file` a read, edit, write or patch of an existing regular file with more
  than one link, and a read when any `AGENTS.md` between its target and the workspace root, which
  the producer's read tool loads as instructions without asking, has more than one link. The
  kernel refuses a sandboxed `link()` to a file the run may not read, so such an alias can only
  predate the run. The kernel profile therefore closes it for every reader at once, whatever the
  runtime reads with (PR #4064 review, #3900 AC2/AC5): before each native launch Keiko scans the
  workspace and every accepted external reference for regular files with more than one link
  (`scanNativeLinkedFiles`) and names them in the filesystem plan (`linkedFiles`, bound into the
  policy digest). Seatbelt then denies each one's contents, extended attributes, writes and links
  to the whole process tree, and create/unlink on the directories between its root and the file,
  so neither the file nor a parent can be renamed onto an undenied name; its metadata stays
  readable, so listings, Git and a search walk still see the entry. The runtime's own search, its
  read tool and a shell child all get `Operation not permitted`; the original 2.1.4 `grep` returns
  the ordinary match and no linked bytes in all three modes. No name or mode exempts a link: an
  outside read-only file linked under a Git object name was readable through it (PR #4064 review),
  so the objects a local `git clone` hard-links are denied too and only counted apart
  (`gitObjectLinkCount`); Git works in such a clone once its objects are its own (`git repack -a
  -d`, or a clone made with `--no-hardlinks`).
  A scan that cannot finish, or that finds more than 1,024 linked files, refuses the launch
  (`workspace-unqualified`, `linked-files-unscanned` or `linked-files-excessive`) instead of
  starting on a partial list; `coding-runtime.linked-files.resolved` records the counts. On macOS
  pnpm and Bun clone package files from their stores by default, so an ordinary install has no
  such links; a project configured to hard-link its store is denied those files. A link another
  process of the same user creates during the run is outside this boundary, as a copy of the same
  bytes would be; the per-action `linked-file` refusal above still covers the native read and edit
  tools. The task workspace and the run's private state are re-allowed after
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
  still inherit nothing. An operator's explicit OpenSSL and FIPS configuration is kept as a
  standalone shell keeps it (#3901 AC4): `OPENSSL_CONF`, `OPENSSL_CONF_INCLUDE` and
  `OPENSSL_MODULES` are inherited, `NODE_OPTIONS` only when it consists of Node's OpenSSL and FIPS
  switches alone, read with Node's own grammar (quotes, escapes inside quotes, `_` for `-`): the
  boolean switches `--openssl-legacy-provider`, `--openssl-shared-config`, `--enable-fips` and
  `--force-fips` in their `--no-` forms too and with any value, which Node ignores, and
  `--openssl-config` with its file inline or as the next option, and the directories they name
  (the configuration file's directory, the include directory, the modules, an
  `--openssl-config=` file's directory) open read-only through `nativeOpenSslReadRoots`, under the
  toolchain root rule: never the user's home or above it, a system prefix or a credential store. The launch gate that keeps a host secret out of the child compares the
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
  is never allowed. Only these edit effects are measured: a shell command is bounded by the
  tool-call budget and the command policy, and the files it changes are not counted in patch
  bytes. A refused, revoked, expired, exhausted or aborted action is denied and
  recorded as `authority-refused` or `cancelled`; a wiring without the owner refuses every action.
- **A selected private skill reaches every productive dispatch.** The Markdown skill pinned on a
  Coding conversation (#4025) is bound to the run's task turn when the run begins, through the
  conversation store's existing immutable turn binding. The coding gateway route resolves that
  binding per dispatch, after the readiness challenge, prefixes the skill's instructions to the
  request's first user message and admits the request again with them counted. It is one owner for
  the native and the mapped profile; no private text enters generated plugin source or runtime
  configuration. A replaced skill keeps the bound revision, a deleted one refuses the dispatch
  (`skill-unavailable`), and `coding-sidecar.gateway.skill-attached` records the identity and sizes
  only. The binding is checked again before every physical provider attempt, a gateway or stream
  retry included, through the existing Markdown-skill attempt admission (composed with, never
  replacing, the request's own): a revision deleted after the first attempt, or a run whose
  capability no longer authenticates, sends no further attempt and ends the turn as rejected
  (409 `SKILL_SELECTION_CHANGED` with `skill-unavailable`, or 401 with `capability-invalid`), so
  the runtime does not resend it.
- **Native child sessions inherit the parent run.** A subagent's session is admitted only when its
  `parentID` chain, read from the runtime's own session list, reaches the run's session within
  eight steps inside the run's workspace (at most 64 cached children). Its asks take the parent's
  mode, policy, approval lane and budget; any other session is refused. The decision line records
  the closed `sessionRelation` (`primary`, `child`).
- **A run's session tree decides when the run is over, whose questions reach the human and how a
  refused question ends a turn (PR #4064).** `opencodeNativeSessionTree.ts` owns the ancestry above
  and what hangs on it: a session that is not proven a descendant never keeps a run alive, asks its
  human or receives an interrupt. The proof is cached for at most 64 children; the bound is the
  cache's, not the run's ownership, so a descendant asked about once the cache is full is still
  proven from the session list (and proven again on its next appearance). A full cache that skipped
  the proof let a 65th active child read as no activity and the tree as terminal (#3897 review).
  - *Liveness.* The producer keeps a subagent launched with `background: true` working after its
    parent went idle and, when it ends (completed, failed or cancelled), appends a synthetic
    message from `subagent` and runs the parent again to read it
    (https://opencode.ai/v2/docs/tools/#subagent; pinned by
    `opencodeNativeChildLifecycle.real.test.ts`). The adapter's status port therefore answers for
    the whole tree: `activity` (the primary runs), `held` (it is idle and an owned child runs, or
    a background shell job of the run runs) or `terminal`. Background jobs are read from the
    producer's own `shell.list` (`GET /api/shell`, running commands only, each naming the session
    whose tool started it); a job of the primary, of an owned child or of no named session is the
    run's (#3901 AC3). A run that started a dev server or a long job in the background therefore
    stays running until the job ended, and the producer's own notification turn after it is part of
    the run, instead of settling and reaping a job that was still working. A success or an interruption settles only when the tree is quiet, confirmed by a
    fresh read at the moment of settlement even when a live hint said otherwise; a failed verdict
    ends the run at once, because settling reaps the tree. The history projection closes the gap
    between a child's end and its parent's restart without a clock: an idle message of a parent
    that launched a background child (a completed `subagent` call naming its session) which has
    not yet reported back is an observation, not the end of the work (`heldIdleCount` on the
    projection line); a failed idle stays a terminal failure. A child that never reports is bounded
    by the run's turn deadline (`maxTurnWaitMs`) like any hang. A stop or turn replacement
    interrupts the primary, then every owned child still running, and the primary again when it
    came back to read a report, stops every background job of the run with `shell.remove`
    (`DELETE /api/shell/{id}`), and settles on two consecutive inactive reads; budget exhaustion
    and every settled turn reap the whole process tree through the manager. Evidence:
    `coding-runtime.native-session-tree.observed` (`held`, `released`, `interrupted`; counts only,
    `activeShellCount` for jobs, a line per change, never per poll).
  - *Questions.* `opencodeNativeQuestions.ts` lists the pending forms of the primary session and of
    its owned children. The producer scopes this list by location: Keiko queries the run's workspace
    and its admitted moved locations explicitly, never the runtime service's default directory.
    It binds an answer or a rejection to the session that asked, and refuses
    instead of routing a stale id or a form of any other session (another parent chain, outside
    the workspace). Run authority and revision checks stay with the callers. The producer's General
    and Explore agents deny `question`, so a child form arises only for an agent whose rules allow
    it; the lane is correct for it either way. Refusing a child's question interrupts the child
    only, and its parent continues with the failed subagent call. An owned form the lane cannot
    show (more than 32 fields or options, a hidden or conditional field, or a field type no answer
    can be given for) is dismissed through the session that asked, as a refusal would be: the
    runtime would otherwise wait for an answer nobody can give, and the validation bound stays.
    Valid sibling forms stay listed, and a form of another session is never dismissed. Evidence:
    `coding-runtime.native-question.routed` (action, outcome, relation, counts, a closed refusal;
    `dismiss` with `form-unrepresentable`).
  - *Sustained history reconciliation.* Critical projections become evictable from bounded staging
    only after every governing sink returns an applied or duplicate receipt and the prepared
    reconciliation commits. Undelivered critical events remain protected. Acknowledgement does not
    widen the event or byte limits; recent identity/digest checks and committed sequence checkpoints
    continue to refuse conflicts and gaps. Existing `coding-runtime.history-projection` evidence
    records the complete, loss-free history projection across sustained native tool rounds.
  - *A refused primary question.* The producer ends that turn with `session.execution.interrupted`,
    removes the session from the active list and writes an assistant message with
    `error.type = aborted`, but no idle message. The live hint is observed only for an execution the
    turn was seen running (a late interruption of a replaced turn settles nothing); the turn settles
    `interrupted` once the tree is quiet and no later verdict was recorded, and the production turn
    port reports it as `cancelled`, not `failed`. The orchestrator settles that run `cancelled`
    through `stopping`, the way an operator stop does, with no failure code; a cause of Keiko's own
    (an escalation of refused edits) still settles it `failed` with that cause. The next turn is
    armed at once. Evidence:
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
  `session.revert.stage` at the first user message of the newest turn and leaves the run live. A
  turn Keiko itself starts to continue the human's request (the automatic verification
  continuation) carries `keikoTurnOriginV1` on its prompt metadata and belongs to that request: the
  newest turn, its `session.diff` (`from` its first user message) and its witnesses reach back
  across it to the human's own turn, so a verification-only continuation cannot hide the human's
  edit from the undo (r4368344091). The
  coordinator reserves the next task generation first, so the interrupted turn's cancelled outcome
  does not settle the run. While the run is live Keiko never calls `session.revert.commit`:
  committing, and the next prompt after a staged revert, delete the rewound messages, while the
  history reconciliation is append-only per session, so a new turn is refused (`turn-blocked`)
  while an undo is staged. The
  runtime restores whole files, so Keiko proves each file unchanged by content before it lets the
  runtime write: the SHA-256 of its bytes, read through a descriptor that follows no link. Size and
  timestamps are no witness, since a same-size copy that puts the old modification time back would
  pass them. The targets of each admitted native `edit`, `write` or `patch` call are fingerprinted
  when the call settles, which is the file as the turn itself wrote it. An undo needs every file the
  turn changed to match its edit's image; a file no edit of the turn wrote (one a shell command
  changed) is proven only by the image recorded when the turn settled, so a turn still in flight
  cannot prove such a file and its undo is refused (`workspace-changed`) without stopping it. After
  the interrupt of a turn in flight the files are proven once more. A restore
  (`session.revert.clear`) needs every restored file to match the image the undo left. A human
  change made while a turn ran, to a file no edit of that turn wrote, is the one change Keiko cannot
  tell apart from the turn's own once the turn settled; the runtime's snapshot counts it as the
  turn's. Evidence is `coding-runtime.revert.applied`, `.refused` and `.dispatch-failed`: counts
  and closed words, never a path, patch or message.
- **A healthy settled native run keeps its undo for a bounded window (#3904 AC3).** A run used to settle when its turn ended and to remove its private state,
  snapshots included, so a settled turn could not be undone, unlike standalone OpenCode. Now a
  native run that succeeded or failed with an undoable newest turn (`session.diff` names a file, or an undo
  is staged) is held instead of stopped: `CodingRuntimeManager.hold` runs the same revocation
  barrier as a stop (runtime capabilities, approvals, research grants, in-flight actions) and
  records the run's truthful result (succeeded or failed), but keeps the process tree until a later `stop` reaps it.
  The run settles normally (history captured, evidence settled, slot published as settled); the
  production slot stays claimed, so no run can start over a held runtime. `CodingRuntimeUndoWindow`
  closes the window when the next run starts or is retried, when the human selects another task
  workspace (that selection waits for the close on the same serial lane), after 30 minutes, or at server
  shutdown. A failed model continuation can still have usable original snapshots: it keeps the
  same bounded window without gaining productive authority or becoming successful. Cancelled runs,
  unhealthy runtimes and turns without a usable snapshot still stop as before. This does not add
  durable failed-run retention or interrupted-run restoration (the separate AC1 obligation). While the window is open
  the coordinator admits undo and restore of the held run, and the counts behind them, under the
  settled snapshot's revision and a one-use request id; the revision advances, the settlement time
  does not. The dispatcher admits them under the current workspace binding
  (`productionWorkspaceMatches`) in place of the ended run authority and refuses every other
  operation on a held run. When the window closes, an undo left staged is committed with
  `session.revert.commit` (the run is settled and its history captured by then, so no live
  projection depends on the rewound messages), then the runtime is stopped and its session retained
  like any settled run. Evidence is `coding-runtime.undo-window` (`opened`, `closed` with
  `next-run`, `workspace-selected`, `expired`, `shutdown` or `not-succeeded`, the staged-undo outcome and whether the stop
  succeeded) beside the existing `coding-runtime.revert.*` lines (`commit` for the final commit).
  The original executable proves the undo, restore and closing commit of a settled turn and that
  the committed session passes the retention audit (`opencodeNativeRevert.real.test.ts`).
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


- **A settled task's runtime session is retained, and the next run may resume or fork it (S02, S03,
  #3904).** Before this, every run started an empty runtime session and a follow-up replayed up to
  24,000 characters of Coding History as hidden context. The pinned 2.0.10 and 2.1.4 producers admit
  `session.fork` (`POST /api/session/{sessionID}/fork`, body `{ before? }` naming a message) and
  `session.remove` (`DELETE /api/session/{sessionID}`); both are in the digest-pinned protocol
  surface (30 operations). Original session state is retained for the native, direct and code-mode
  profiles alike: a mapped tool profile is not a reason to discard the original session. Every run
  still generates its own tool configuration and capability bindings; old message ids are excluded
  from new tool-receipt projection. Both profile families bind the current model through the owned
  provider alias and reset the resumed agent to `build`. Linux keeps its mapped tools and its
  existing namespace boundary; graceful Linux shutdown uses the owned stdin lifetime, and uncertain
  reaping denies retention. The authenticated service control route uses ADR-0043 D12's bounded
  private-IPC forwarding. This does not qualify or enable native Linux tools.
  The design keeps authority out of the persisted state:
  - **Retention.** When an original runtime run ends `succeeded`, `failed` or `cancelled` through a settled stop
    (the manager passes the lifecycle settlement only for `stop()`, and the composition audits after
    the runtime process was reaped; an unsettled kill or timeout retains nothing) the run's `opencode.db`
    is copied with SQLite `VACUUM INTO` (a consistent, compacted copy) to
    `<stateDir>/coding-runtime/retained-sessions/<sha256(task)>/`, outside every workspace and run
    root. One entry per task; a new entry replaces the previous one and a run that retains nothing
    removes it. The manifest binds the database's sha256 and size, the task, a digest of the workspace
    identity, the session id, the runtime version and the input window the history was built under.
    The copy must hold exactly one top-level session and no row in any grant, credential or pending
    table, no suspended or archived session, no staged revert and an empty permission ruleset;
    an unknown schema is refused rather than guessed. Because the whole database crosses this
    boundary, its schema is bound to the producer's persistence contract
    (`opencodePersistenceContract.ts`, #3908 AC4): exactly the tables and columns each admitted
    runtime's own migrations create for the session's runtime version, derived from genuine 2.1.4
    and 2.0.10 databases and proven against real settled runs
    (`opencodeNativeSessionResume.real.test.ts`, with `KEIKO_OPENCODE_REAL_VERSION` selecting the
    admitted producer). The still-published 2.0.10 runtime lacks only the two newer project columns
    `time_active` and `time_archived`; its own schema is admitted without relaxing any state audit
    or allowing a different runtime version to resume the session. An
    added table or column (even an empty one), a view, a trigger, a missing one, or a version with no
    contract is refused as `schema-unknown` with the audit check `schema-drift`, so a producer
    upgrade cannot carry unexamined persisted state forward. A new runtime version needs its own
    producer-derived contract before its state is retained. Bounds: 128 MiB an entry, 512 MiB and 32
    entries in all, 14 days, 3,000 messages; the store prunes on startup and on every retain, and an
    entry whose task Coding History no longer holds is removed. `KEIKO_CODING_SESSION_RETENTION=off`
    retains, resumes and forks nothing; any other unknown value fails closed to off.
  - **Resume.** The orchestrator declares the intent before it launches; the composition's prepare
    step checks the entry out into the new run's own state root (exclusive copy, then the digest and
    the audit again, workspace, runtime version and window checked against the new run), so the
    retained entry is never written by a run. After the handshake the composition binds the run to
    the one session the database holds, resets its agent to Build (the launch profile's default,
    which a fresh run also starts under; a read-only Plan run must not silently turn the next task
    into one), and the orchestrator skips the history replay for a resumed run. The gateway readiness challenge of a
    continued run runs in a scratch session that is removed afterwards, so the probe's prompt is not
    in the resumed history. The history projection and capture filter the messages the database held
    at the start by id (the baseline), so a persisted message is neither re-emitted into the timeline
    nor recorded in Coding History twice. The run's authority, model route, workspace binding and
    approvals are minted fresh by the orchestrator exactly as for a new run. Keiko answers a runtime
    permission request with `once` or `reject` and never `always`, and both clients refuse any other
    reply before it is sent (`opencodePermissionReplies.test.ts`), so no grant can have entered the
    database that the audit would not also have refused.
  - **Fork.** A start request may carry `fork: { taskId, beforeMessageId? }` and no conversation id.
    The orchestrator refuses it with `invalid-intent` before any run exists when the source is not a
    task of the active workspace or the named message is not one of its user turns. Coding History
    creates a new task whose first run is the synthetic `inherit-<runId>`, copying the inherited
    messages with their original timestamps and recording the provenance (`coding-runtime.history`
    `forked`). The composition checks the source's entry out for the new run, forks it with
    `session.fork` before the user turn the boundary names (located by the turn's ordinal among the
    source's user turns, with the runtime's own count required to agree, never by a client-supplied
    runtime id), makes the fork the run's session and removes the copied source session with
    `session.remove`. The fork runs in the same workspace under fresh authority, and the source's
    retained entry and Coding History are left untouched. A fork refused because the requesting
    run has another workspace or runtime version likewise leaves its source entry intact; it does
    not copy that entry to the refused destination. Integrity and expiry refusals keep the existing
    cleanup rules.
  - **Fallback.** Every refusal starts a fresh runtime with the Coding History context, today's
    behaviour, and says why with a closed reason on the Activity Log: `disabled`,
    `not-native-profile`, `not-succeeded`, `no-session`, `no-task`, `no-retained-state`, `expired`,
    `integrity-failed`, `version-changed`, `workspace-changed`, `window-shrunk`, `schema-unknown`,
    `grant-present`, `credential-present`, `pending-input`, `revert-staged`, `session-mismatch`,
    `database-missing`, `database-oversized`, `copy-failed`, `agent-reset-failed`,
    `history-oversized`, `scratch-session-failed`, `fork-boundary-unresolved` and `fork-failed`.
    A refusal that proves the entry unusable removes it, except `window-shrunk`, which a larger
    window can still take.
  - **Evidence.** `coding-runtime.session-continuity` records, per retain, resume, fork and prune, the
    action, the outcome (`retained`, `resumed`, `forked`, `pruned`, `fresh`, `skipped`, `refused`,
    `failed`), the closed reason, byte and message counts and digests of the task and its fork source;
    never a path, a message or a session id. A refused or failed line keeps its diagnostic frames
    and cause chain under the run's correlation id.
  - **The Workbench.** Fork task (on the loaded task) and Fork from here (on each user message of the
    previous conversation) are the person's own requests: a notice announces the pending fork and
    can cancel it, it ends with the run or task it was made against, it is not offered while a run is
    active, and the next start carries the fork instead of the conversation id.
  - **Terminal retention.** After its process is reaped, a failed or cancelled native run may retain
    its current session only through the same strict database and binding audit as a successful run.
    Grants, credentials, pending input, staged reverts, unknown state or schema drift still refuse
    retention, remove the stale entry and use history replay. No persisted authority is restored.
    Unsettled runs retain nothing.
  - **Not done.** The mapped (non-native) profile retains nothing; `session.update` (rename) stays
    refused; a fork inside the run the timeline shows is offered only as a whole-task fork.

What this amendment does not change: the three modes and the Authority Envelope (ADR-0124,
ADR-0129, ADR-0138), the hard denials (ADR-0129 D3), Git delivery as a Keiko product operation
with signed commits and bounded refs (ADR-0135, ADR-0087), evidence redaction (D7) and the one
attested loopback origin for gateway and facade (D4).

