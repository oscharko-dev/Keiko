# Epic #2091 agent docking security review — historical findings

Date: 2026-07-10

Scope: Epic #2091 and child issues #2114 through #2122, covering the editor-agent producer,
multi-file changesets, live editor context, chat docking, presence/audit surfaces, and Authority
Envelope enforcement.

## Current scope and policy (2026-10-03)

The finding and verification sections retain the dated 2026-07-10 review. The ordinary Editor's
agent action subscription, dispatch, presence, patch review, selection-to-chat handoff, and Chat
**Apply to editor** are now retired. The exclusive Chat authority wrapper and its local authority
factory are removed. The independent Coding Workbench and shared governed producer, transaction,
authority, and verification paths retain their existing behavior.

Current policy follows ADR-0138 and `AGENTS.md`: **Ask for approval** requires approval for workspace
mutations; **Supervised workspace** permits routine contained work within its validated authority;
**Full access** permits work within the validated Authority Envelope and server ceiling. Accepted
repository delivery follows ADR-0135; the product's Governed Merge Gateway remains approval-gated.
Hard denials for invalid authority, workspace escape, sensitive paths, secret exfiltration,
unsupported actions, exhausted budgets, and invalid execution leases remain independent.

The ordinary Editor publishes body-free buffer-safety state only. Its separately scoped ownership
token cannot authenticate actions or SSE, expose agent context, or make it discoverable. Dirty
state survives disconnect and participates in the existing verified-commit guard. Clean release is
owned and acknowledged; restart reseeding cannot replace any existing record. These constraints
are covered by `editor-agent.test.ts`, `agentSessionRegistry.test.ts`, `agentRoutes.test.ts`, and
`productionVerifiedCommitDependencies.test.ts`. This is preservation of unsaved-buffer safety,
not a new agent execution path.

## Historical trust boundaries reviewed

1. `keiko-tools` model-facing schemas and the bounded loopback HTTP producer.
2. Shared editor-agent wire parsing in `keiko-contracts`.
3. `/api/editor/agent/*` admission, policy, queue, SSE, result, and audit handling.
4. `keiko-tools` patch inspection and atomic apply/rollback.
5. The browser bridge, review surface, terminal result capability, and Monaco reconciliation.
6. Bounded diagnostic detail and the redacted `editor-state` context provider.

## Confirmed findings and fixes

### High: producer POSTs omitted the BFF mutation guard

The default `EditorAgentHttpClient` fetch transport sent JSON POSTs without `X-Keiko-CSRF: 1`, so
the real BFF rejected the first producer request before editor-agent admission. The transport now
adds the guard to POST only, retains manual redirect handling and loopback-only origins, and keeps
response/time bounds. `editor-agent-client.test.ts` proves GET/POST header separation, streaming,
oversized responses, cancellation, timeout, redirects, malformed responses, and redaction.

### High: bare action parsing retained unknown authority fields

The semantic action guard accepted structurally valid objects with unknown fields, and the bare
action parser copied those objects with a spread. A hostile producer could therefore carry unknown
authority or capability canaries farther into the route and SSE path. The parser now emits a deep,
canonical projection of actions and results, including nested targets, edits, changesets,
preconditions, conflicts, and per-file results. Unknown fields are not retained.

`editor-agent.test.ts` proves canonical projection at the contract boundary.
`agentRoutes.test.ts` additionally proves unknown capability and authority canaries are absent from
target SSE, terminal results, and audit records.

### High: identical authority registration reset cumulative budgets

The authority registry previously replaced an existing run-id/envelope-digest record, resetting
elapsed time, tool calls, and patch bytes. Registration is now idempotent for an identical record;
exhausted records remain present and denied until envelope expiry or explicit revocation.
`agentAuthorityRegistry.test.ts` exhausts usage and runtime, re-registers the same envelope, and
proves both budgets remain exceeded.

### High: delayed SSE close retained stale pane liveness

Pane snapshots are intentionally retained, but transport close delivery could lag after an active
pane switch and leave both old and new sessions discoverable. Each browser page now presents one
random, memory-only stream id. A newly authenticated stream atomically replaces that stream id's
prior server subscription, while genuinely independent browser pages remain ambiguous and fail
closed. Stream ids and capabilities are scrubbed from request URLs after authentication.

### Medium: wrapper schemas and action payload variants were too permissive

Snapshot and result wrappers now require exact schema version `"1"`, kind, and allowed outer keys.
Action payload fields are type-discriminated, preventing an `applyTextEdits` action from carrying an
uncounted patch. Existing server-prepared `applyPatch` text edits remain valid. Contract and route
tests cover missing or foreign schema versions, additional keys, and type-foreign payloads.

The original review recorded no unresolved high or critical finding after these fixes. This is
not a claim about the current branch's full gate or review status.

## Historical adversarial verification matrix

| Boundary                         | Adversarial cases                                                                                                                  | Passing evidence                                                                                |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `applyTextEdits`                 | `.env`; Unix absolute path; `../`; Windows drive path; missing/stale pins                                                          | `agentRoutes.test.ts`: sensitive-path policy tests, AC5 containment tests, precondition tests   |
| Single-file `applyPatch`         | denied target; out-of-workspace target; traversal; symlink and hard-link alias; malformed/multi-file patch                         | `patch.test.ts` and `agentRoutes.test.ts` applyPatch preflight tests                            |
| `applyChangeset` sensitive paths | safe member followed by `.env`, `.ssh/id_rsa`, `.keiko/state.json`, or `.aws/credentials`; no reads or writes to the denied member | `agentRoutes.test.ts`: generated `rejects a safe plus deny-listed ... changeset` matrix         |
| `applyChangeset` escape          | safe member plus `../outside.txt`; absolute member; target replaced after queueing by an outward symlink                           | `agentRoutes.test.ts`: escaping-member matrix and commit-time outward-symlink test              |
| Whole-action preconditions       | stale second member; live snapshot made unverifiable; unselected members still validated                                           | `agentRoutes.test.ts`: stale-member, verifiable-counterpart, and selected-file projection tests |
| Authority and capability         | missing/wrong/replayed bridge capability; expired changeset authority; delayed stream close; unknown-field smuggling               | `agentRoutes.test.ts`: bridge lease/supersession, changeset expiry, and canonical-wire tests    |
| Atomicity                        | browser rejection; stale member; writer failure on a later member; replay; forged result                                           | `agentRoutes.test.ts`: apply-none, rollback, idempotency, and forged-result tests               |
| Authority budgets                | cumulative tool calls and UTF-8 patch bytes; elapsed runtime; text-edit bytes; identical re-registration                           | `agentAuthorityRegistry.test.ts` and `agentRoutes.test.ts` Authority Envelope budget tests      |
| Cross-pane reconciliation        | active-pane switching; stale retained snapshots; clean peer model; dirty/delete rechecks; bounded queue                            | historical route/queue/runtime and former `editor-agent-pins` session pin (#2955)               |
| Diagnostics/context              | item/message caps, ingest rejection, truncation, unsafe-format stripping, redaction                                                | `editor-agent.test.ts`, `agentRoutes.test.ts`, and `codingContextProviders.test.ts`             |

The credential-path case intentionally uses a well-known credential store (`.aws/credentials`). A
generic project directory named `credentials` is not itself denied because it can contain legitimate
domain source. Known credential directories and credential filenames remain always-on denies, while
secret-shaped content elsewhere is handled by the redaction boundary.

## Disk mutation and review

`applyChangeset` uses one server-owned transaction. Every declared file is parsed, contained,
sensitive-path checked, and precondition checked before selected-file projection. The selected patch
is validated again immediately before atomic apply, and an apply failure rolls back prior members.
The server also re-resolves Authority Envelope expiry and policy after the browser's terminal
acknowledgment.

The original review distinguished supervised high-risk browser review, policy-allowed changesets,
and Chat Apply followed by manual Save. Those ordinary Editor browser journeys are retired.
`tests/e2e/editor-manual-pins.spec.ts` now verifies manual undo/redo and split-pane operation without
agent control requests. It does not claim agent reconciliation or Workbench transaction coverage.

The shared server transaction and its independent Workbench consumers remain unchanged by this
retirement. Their existing authority, containment, precondition, atomicity, and verification tests
must remain in place. See [the current demo](./2091-agent-docking-demo.md) for the ordinary Editor
scope and [the historical regression evidence](./2091-agent-docking-regression-evidence.md) for the
original measured results.

## Audit and data handling

Editor-agent audit records contain only bounded identifiers, action type/origin, policy disposition,
reason code, status, target label, counts, and byte counts. They do not contain patch text, file
content, diagnostic messages, selections, prompts, credentials, reusable capabilities, full
Authority Envelopes, or private endpoints. The reviewed execution capability is random, memory-only,
session-bound, and consumed through an execution lease for active independent consumers. The
ordinary Editor's passive safety token may be retained in sessionStorage across reload; it grants
only owned snapshot refresh and clean release, never execution authority.

## Disposition

Historical security review: **passed after four high-severity fixes and one medium hardening group**.
Sensitive-path, containment,
precondition, authority, capability, budget, atomicity, and redaction controls have named passing
regression coverage. No governance gate or deny was weakened.
