# ADR-0124: Coding autonomy modes and sidecar runtime authority

## Status

Accepted (Issue #1986, 2026-07-07).

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
Authority Envelope and approval gates. It still excludes delivery-substrate authority.

`autonomous-delivery` is the highest mode. It may include delivery-substrate actions, but only when
the Authority Envelope explicitly grants them and only in later children that implement those
surfaces. Naming the mode here does not implement the runner.

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
