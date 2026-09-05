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
human text. The pinned OpenCode 1.17.17 prompt transport sends context as a separate `synthetic: true`
text part: it reaches the model but the existing safe-activity projection omits its user-message echo.
The combined prompt retains the existing byte ceiling. The Codex control port currently accepts
only text, so its adapter composes the same labelled context after explicit-skill tracking; it never
feeds that composed string back into skill authorization. Follow-up turns carry no implicit context.
The existing body-free `coding-runtime.run.issue-context-attached` event records initial attachment;
raw context stays absent from runtime snapshots, generated runtime configuration and activity logs.

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
cumulative runtime/tool/patch budgets. Each adapter delegation has a fresh idempotency/replay
identity. Before every delegation, the BFF re-resolves live facts and rejects task, workspace,
project, branch, action/connector scope, budget, runtime source, or model source drift. Expiry,
delegation replay, stop, and takeover fail closed. V1 permits exactly one active run per BFF; a
concurrent start returns `active-run-conflict` deterministically.

### D3 — Runtime state and failures are closed

The server-owned state vocabulary is exactly `unavailable`, `idle`, `starting`, `ready`, `running`,
`awaiting-approval`, `stopping`, `succeeded`, `failed`, `cancelled`, `taken-over`, and
`recovery-required`. Legal transitions are an explicit total table; unknown states and implicit
self-transitions fail closed. Failure codes distinguish authority resolution, expiry, replay,
revocation, concurrency, and each drift axis without carrying raw process or model content.

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

Content-bearing live prompt, response, diff, and diagnostic events are transient, bounded, and
access-controlled. Durable operational events and evidence are a separate content-free projection;
they carry only ids, digests, counts, booleans, closed states/codes, and safe labels.

Commit, push, pull-request create/update, merge, and Authority Envelope widening each require their
own action-bound, one-use human approval in addition to runtime authority. No mode, connector scope,
or earlier start confirmation pre-approves those delivery actions.

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
