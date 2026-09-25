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
existing probe spend ledger. It never runs when a subscription source is selected, when the
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
tool call it asks for (`actionId`, the call's own `sessionID:id` identity, bound to the ask id) and,
for a changeset edit, one base digest per asked file (`baseDigests`: the file and the
`expectedContentHash` the edit is built on). Both are body-free. The approval registry validates
them fail-closed with exact keys, so an ask that names another call or session, or whose bases do not
match the asked files, never reaches the human (#3612). Before an edit ask is put to the human, the
server compares each base with the digest a governed read of the file reports now. The read goes
only as far as `keiko_workspace_read` would: the run's live authority and producer binding must
admit a read of the path before and after it, without reserving a delegation. An expired or
revoked run reads nothing, and its ask is refused as unavailable instead of reaching the human
unverified. A stale base is refused without asking anyone, answered 409 with the
edit's own `CONTENT_HASH_MISMATCH` refusal and re-read guidance for the model, and logged as
`approval-stale` on the existing `coding-sidecar.tool-facade.rejected` line. Every check writes
`coding-runtime.approval.base-checked` under the run's correlation: the ask's request id, the
outcome (`current`, `stale`, `denied`, `failed`, `cancelled`), the file counts up to where the check
ended, and a stale file only as a digest. An ask that arrives after, or whose check finishes after,
the run's approval registry closed is cancelled, logged as `cancelled`, and reaches no one. A denied ask settles its tool call as `denied`, an expired
or cancelled one as `cancelled`, so the timeline shows the human's verdict instead of the generic
failure OpenCode reports for a refused call.

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
