# ADR-0127: Server-owned Coding Workbench runtime contracts and authority

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

## Decision

### D1 — Browser input is intent, never authority

The closed start request contains only a request id, transient task intent, requested mode, and
model source. Stop, takeover, and recovery requests contain only a request id and run id. Exact-key
validation rejects every additional field. Raw task intent is transient model input and is absent
from durable runtime state, events, failures, and evidence.

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
  process-tree revocation, transport/backpressure, and real-binary execution belong to ordered
  corrective children and cannot be inferred from these contracts.

## Alternatives considered

### Confirm a browser-authored envelope

Rejected. Validation can prove shape, but cannot make caller-selected roots, scopes, ceilings, or
budgets authoritative.

### Put adapter launch configuration in the shared request

Rejected. It would make browser-safe contracts a process-authority and credential transport.

### Add a coding-specific workspace or editor registry

Rejected. Existing task-workspace and editor-agent authorities already own those invariants.
