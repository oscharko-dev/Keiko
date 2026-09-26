# ADR-0124: Coding autonomy modes and sidecar runtime authority

## Status

Accepted (Issue #1986, 2026-07-07).

> **Superseded in part by [ADR-0125](ADR-0125-governed-agent-docking-and-editor-changesets.md).**
> `governed-assist` is displayed as **Ask for approval** and permits contained edits, saves, and
> commands. All action classes are capability-admissible in every mode but are not thereby
> pre-approved. The three machine values remain unchanged; tri-state resource/risk policy replaces
> the stale read-mostly and blanket-write assumptions.

> **Amended by [ADR-0138](ADR-0138-monotonic-product-wide-autonomy-semantics-and-code-task-terminology.md).**
> `supervised-coding` is displayed as **Supervised workspace**, the mode/resource/risk policy is the
> total monotonic matrix in ADR-0138 D2, and "sidecar" is retired in favor of the canonical
> runtime artifact/process/adapter/host vocabulary. The three machine values remain unchanged.

## Context

Epic #1982 introduces the governed Coding Workbench. Later child issues will add the sidecar
runtime, Model Gateway routing, UI surfaces, connector execution, and delivery runners, but those
surfaces need one shared contract and policy vocabulary first. Without one decision record, every
child would be forced to invent its own mode names, approval envelope, event shapes, and evidence
rules, which would create policy drift precisely at a trust boundary.

Keiko already enforces the human-control invariant, keeps contract code browser-safe and
dependency-free in `@oscharko-dev/keiko-contracts`, isolates provider SDKs inside
`@oscharko-dev/keiko-model-gateway`, and requires content-free evidence for governed actions.
Coding Workbench contracts must extend those rules instead of creating a second authority stack.

This ADR defines the first shared contract baseline only. It does not authorize process launch, Git
mutation, connector execution, or delivery automation by itself.

## Scope

In scope:

- the three Coding Workbench autonomy modes,
- the fail-closed deployment-ceiling and effective-mode rule,
- the Authority Envelope contract and required fields,
- sidecar runtime authority boundaries and event vocabulary,
- permission-request vocabulary,
- runtime-source and model-source separation,
- source-control and issue-tracker connector scopes,
- content-free coding evidence and redaction requirements.

Out of scope:

- process launcher mechanics,
- Model Gateway endpoint implementation,
- Codex or ChatGPT subscription adapter implementation,
- Git execution,
- connector-specific behavior,
- UI behavior,
- delivery-runner implementation details.

## Decision

### D1 — Coding Workbench has exactly three autonomy modes

The shared mode vocabulary is:

- `governed-assist`
- `supervised-coding`
- `autonomous-delivery`

These names are closed contract values, not display copy. Call sites must use the shared types
rather than local string literals.

`governed-assist` is the lowest authority posture. It is for read-mostly guided assistance,
verification-oriented activity, and content-free connector metadata. It does not authorize
workspace mutation, local command execution, or delivery-substrate activity.

`supervised-coding` adds governed workspace writes and governed command execution under an explicit
Authority Envelope and approval gates. Delivery-substrate activity is not excluded outright —
ADR-0138 D2 corrects this: every delivery effect (commit, fetch, pull, push, pull-request, merge)
remains separately approval-required in this mode, never a flat, unredeemable denial.

`autonomous-delivery` is the highest mode. It may include delivery-substrate actions once the
Authority Envelope explicitly grants them and a later child implements the corresponding surface,
but a delivery effect is never admitted from the mode label alone: ADR-0138 D2 keeps delivery
separately governed. The accepted Code-task path may use the live, action-specific Full access
envelope as policy authorization for commit, push, and draft-pull-request execution without a
per-action operator claim; Ask and Supervised still require that claim, and merge remains explicit.
Naming the mode here does not implement the runner.

### D2 — Effective mode is the fail-closed minimum of request and deployment ceiling

The effective mode is computed as the minimum of:

- the requested mode for the current task, and
- the deployment ceiling configured for the environment.

Unknown, missing, or malformed values fail closed to `governed-assist`.

No caller may widen authority by passing a higher requested mode than the environment allows. The
effective mode, not the requested mode, is the authority-bearing value for validation, runtime
policy, and evidence.

### D3 — Every governed coding run carries an Authority Envelope

The Authority Envelope is the single shared contract for a governed coding run. It must include:

- run id,
- local user identity,
- task references,
- workspace identity,
- branch constraints,
- requested mode,
- deployment ceiling,
- effective mode,
- runtime source,
- action classes,
- connector scopes,
- model profile,
- command policy,
- network policy,
- gates,
- budget,
- expiry,
- approval proof digest.

Validation is fail-closed. Missing expiry, missing action classes, unknown connector scopes, missing
workspace identity, or an invalid approval-proof digest reject the envelope.
Documentation and Confluence connectors remain deferred out of this epic's connector scope.

The envelope is content-free. It names digests, ids, counts, and closed enums, never prompts,
diffs, file bodies, credentials, private URLs, command logs, or full paths.

### D4 — Sidecar runtime authority is additive and split from delivery substrate

The sidecar runtime owns coding-run execution authority only for the action classes explicitly
granted by the Authority Envelope. It does not own unconditional delivery authority.

Delivery-substrate authority is modeled as its own action class and stays separately governed.
Issue #1983 owns the D10 implementation split for that substrate. This ADR fixes the contract
boundary now so later children do not blur coding assistance with delivery execution.

Successful workspace verification is independent of commit eligibility. The model-facing result
reports `verification.status: passed` and the completed check kinds. Optional `verification.commit`
evidence may still refuse a commit because the candidate is unstaged or has drifted. That refusal
never reclassifies executed checks as unrun and never requires staging for ordinary coding work.
Staging and fresh commit proof remain mandatory only for an accepted commit/delivery action.

Runtime event contracts are content-free and closed. The shared event family includes:

- runtime start/stop/health,
- task submission,
- streaming observations,
- permission requests,
- diff summaries,
- verification summaries,
- final artifact summaries,
- redacted failures.

These events carry ids, counts, digests, status enums, and safe labels only.

The runtime snapshot may also carry optional, provider-reported context-window accounting. Current
input occupancy, reserved output, free capacity, and cumulative run prompt usage remain distinct
facts. Keiko validates exact token geometry and shows only breakdown or compaction fields supplied
by the runtime; it never invents a model capacity, a compaction threshold, or attribution such as
skills, memory files, or deferred tools. Missing telemetry is an explicit unavailable state rather
than a guessed limit. The corresponding activity event contains only counts and an opaque sample
digest.

### D5 — Runtime source and model source stay separate

The runtime source and the model source are different contract axes and must not be conflated.

Runtime source answers: which governed runtime path executed the workbench task?

Model source answers: which governed model-routing posture backed the model profile?

The shared model-source vocabulary is:

- `keiko-model-gateway`
- `openai-api-key-through-gateway`
- `chatgpt-codex-subscription-profile`

This separation is load-bearing. ChatGPT/Codex subscription credentials are not modeled as OpenAI
Platform API keys or generic provider credentials. They remain a distinct subscription/profile path.

Opening the Workbench reads the selected provider profile and model catalog. While the gateway
is the selected model source, the profile read also lets the server verify what the Workbench
needs and the stored configuration does not prove — an expired or missing tool-call proof, and a
context window below the coding minimum that the gateway never declared — so the operator is not
sent to Gateway Settings for something Keiko can determine itself (owner decision for 1.1.1,
amending #3561; mechanics and log lines in ADR-0173). That verification is bounded: only models
that claim tool calling, one attempt per deployment identity within a six-hour cooldown, under the
existing probe spend ledger. A model claims tool calling when it is admitted to call tools or when
Keiko's forced tool-call probe verified it before. The gateway config loader stores a proof that
aged out, or that is bound to another deployment configuration, as `toolCalling: false`; such a
model still claims tool calling and gets its proof renewed, so a restart the day after setup does
not leave the Workbench blocked (1.1.8 lab). A model whose probe refuted tool calling
(`unsupported`) or never concluded claims nothing and is not probed from here. Only a fresh proof
admits a model to a run. It never runs when a subscription source is selected, when the
deployment policy disables the gateway source, or when the gateway is not configured. The same
gateway capability evidence gates all models.

A run start admits the chosen model — the default one or one picked in the model selector — only
when its prompt window holds the coding minimum, the rule the default model's readiness already
applies (#3603). A model below it is refused before any runtime starts, as `model-unavailable` with
the body-free `modelRefusalReason` `model-context-window-insufficient`, or
`model-verification-pending` while the automatic probe that could prove a larger window is still
running, and the Workbench names that reason in both locales. When the gateway route refuses the
runtime's readiness challenge request, a deterministic 400, the start ends at once as
`gateway-challenge-failed` (handshake diagnostic reason `gateway-refused`) instead of waiting out
the start timeout.

### D6 — Permission requests are typed, explicit, and content-free

The sidecar runtime may request additional approval only through the shared permission-request
contract. Request kinds are closed and action-class aligned, including:

- workspace write,
- command execution,
- network egress,
- connector access,
- delivery substrate.

A permission request carries only ids, enums, expiry, requested connector scopes, and redacted safe
labels. It never carries raw command logs, file contents, prompts, or credentials.

The V2 governed ask a generated OpenCode plugin sends (`action: "permission-request"`) also names the
tool call it asks for (`actionId`, the call's own `sessionID:id` identity, bound to the ask id). It is
body-free. The approval registry validates the ask fail-closed with exact keys, so an ask that names
another call or session, or carries any other field, never reaches the human (#3612). An ask that
arrives after the run's approval registry closed is cancelled and reaches no one.

A file edit raises no governed ask in any mode (owner decision, 2026-09-26). Its one human approval
is the change review the mode policy requires before anything is written: the edit port registers
the mutation with `requiresReview` from the ADR-0138 matrix (`governed-assist` and
`supervised-coding` review every workspace edit, `autonomous-delivery` applies without one) before
the editor action is queued, and the editor route refuses a stale base
(`CONTENT_HASH_MISMATCH`, with re-read guidance for the model) before the review is shown. Until
1.1.10 an edit in "Ask for approval" took two decisions for the same change — an ask with the file
list, then Apply on the diff — and the edit ask carried the changeset's base digests so a stale base
could be refused before the first of them; with the ask gone, that pre-ask check went with it.

Rejecting the change in its review is that human decision's "no" for the one edit. The editor route
completes the run's mutation lease as `rejected` before anything is claimed or written, so the
rejection never counts as a failed mutation of the run (a run whose last edit was rejected can still
succeed); `coding-runtime.editor-mutation.settled` records `rejected` at info level under the run's
correlation, and the model receives the same declined-step result and guidance as a declined ask,
so the timeline reads the step as `denied`. Before this, the review's "no" settled as a failed
mutation (`EDIT_MUTATION_FAILED`, `errorKind` `internal`), the model was told its edit had failed,
and the run failed with `mutation-failed` when that edit was its last. Closing the review card is
routine and reports nothing from the browser; the server line above is the review's evidence.

A human's "no" rejects one step, not the run (owner decision, 2026-09-26). The run returns to
`running`, or to its next queued ask, under a new revision; `Stop` remains the way to end a run. The
model learns why the step did not happen and goes on without it: a denied or expired plugin ask
answers 409 with the call's own result (`status` `denied`, or `cancelled` for an expired one, no
evidence, and a fixed guidance sentence), which the plugin returns to the model in place of the
call, and a denied native OpenCode ask is rejected with that guidance as its `message`, which
OpenCode 2.0.10 hands to the model as the correction for that call so its loop goes on (a bare
reject would end the turn). A cancelled or unavailable ask stays a bare refusal. Every decision on
the run's active approval writes `coding-runtime.approval.decided` (`approved` or `denied`) under the
run's correlation (1.1.10 lab: an approval left no coding-runtime line of its own). Before 1.1.10 a
denial stopped the run as `failed`/`revoked`. The tool call a refused ask ends is settled with the
human's verdict — `denied`, or `cancelled` for an expired or cancelled ask — so the timeline shows it
instead of the generic failure OpenCode reports for a refused call.

A Git stage, commit, push or pull-request proposal is asked for by the server itself, not by a child
process, and its tool call waits on the server for the operator's decision. An approval releases
that wait by issuing the proposal's approval; a denial releases it through the run's approval bridge,
which records the decline for that run and proposal, so the call answers at once with the same
declined-step result and guidance, and `coding-runtime.tool-result` records the settled wait with
reason `denied` at info level. Before this, nothing answered a denied proposal: the run ending on a
denial had released the wait by its abort, and with the run going on the call held until the
approval ceiling (1.1.10 e2e: a denied commit left its call pending and the run silent).

The run's own wait on an approval ends at the same instant as the ask's
(`MAX_APPROVAL_CHALLENGE_TTL_MS` is the human-decision wait): an active approval nobody decided in
time is retired, the run returns to `running`, or to the next queued ask, under a new revision, so
the Workbench stops offering a card nothing can decide; an ask that arrives after the expiry is never
queued behind the expired one: the oldest live queued ask takes the card first and the late ask
queues behind it, and only when no live queued ask waits does the late ask take the expired one's
place. A queued ask whose wait ran out before its turn is retired as well instead of stopping the
run. Each retirement writes `coding-runtime.approval.retired`, whose `replaced` is true only when the
late ask took the expired one's place (1.1.9 lab: the expired card stayed on screen, approving it
failed as `invalid-intent`, and the model's next ask expired unseen behind it). An approval that is
decided, retired, or whose run settles takes its expiry timer with it.

### D7 — Coding evidence is content-free by construction

Coding Workbench evidence records are contract-validated and redacted before persistence or review.

Allowed evidence content is limited to:

- ids,
- digests,
- counts,
- booleans,
- closed enums,
- safe labels that pass evidence-safe validation.

Rejected evidence content includes:

- raw prompts,
- raw model output,
- raw diffs,
- file contents,
- command logs,
- issue bodies,
- credentials,
- private URLs,
- full paths.

Redaction helpers may over-redact after detecting a private path or token-bearing string. That
conservative posture is correct. Losing detail is acceptable; leaking sensitive or content-bearing
material is not.

## Consequences

### Positive

- Later Coding Workbench issues can share one contract vocabulary instead of redefining local
  variants.
- Deployment policy can cap authority without trusting a caller-supplied requested mode.
- The runtime, UI, and server surfaces can agree on one permission and event model.
- Model Gateway routing and Codex-subscription routing stay separated at the contract level.
- Evidence review remains content-free and compatible with Keiko governance.

### Negative

- The first contract set is intentionally conservative and may require additive extension in later
  children.
- Some later runtime or UI work may need to map richer internal states down to the shared closed
  event vocabulary.
- Delivery-substrate behavior remains intentionally deferred, so the highest mode is named before it
  is executable.

## Alternatives considered

### A1 — Let each child issue define its own coding-workbench vocabulary

Rejected. That would duplicate policy concepts across runtime, UI, connectors, and delivery
surfaces, making trust-boundary review harder and enforcement inconsistent.

### A2 — Use one open-ended “agent mode” string with optional flags

Rejected. Open-ended strings plus per-call flags are harder to validate, easier to widen by
mistake, and weaker at package boundaries than a small closed mode set.

### A3 — Treat Codex subscription routing as just another API-key provider

Rejected. Subscription-backed Codex/ChatGPT routing has different credential semantics and must not
be represented as a generic OpenAI Platform API key.
