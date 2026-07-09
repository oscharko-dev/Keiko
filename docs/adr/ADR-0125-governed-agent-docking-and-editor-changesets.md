# ADR-0125: Governed agent docking and editor changesets

## Status

Accepted (Issue #2114, 2026-07-09).

## Amends

This decision supersedes in part the stale review, mutation-owner, action-set, and autonomy-mode
semantics in ADR-0058, ADR-0059, ADR-0060, ADR-0061, ADR-0062, and ADR-0124. Their unaffected
containment, concurrency, queueing, browser ownership, audit, Authority Envelope, and evidence
decisions remain in force.

ADR-0125 was allocated after refreshing `origin/dev` and checking all open pull requests on
2026-07-09. `origin/dev` ended at ADR-0124 and there were no open pull requests claiming ADR-0125.

## Context

Keiko has two compatible foundations that now need one docking contract: the Coding Workbench's
three machine autonomy values and Authority Envelope, and the editor-agent route/session/bridge
control plane. Earlier editor ADRs assumed every content mutation required a per-patch browser
review and that the browser was the only mutation owner. ADR-0124 also described
`governed-assist` as read-mostly and unable to write or execute commands. Those assumptions are no
longer the product policy.

The corrected policy exposes Codex-like user modes while preserving the existing machine values.
Normal workspace-contained edits, saves, and commands are allowed in every mode. Approval varies
by resource scope and risk; it is not a blanket save prohibition. The Authority Envelope,
deployment ceiling, workspace containment, deny lists, secret-exfiltration prevention, platform
restrictions, and delivery controls remain independent gates.

This issue defines contracts and decisions only. Later children wire policy evaluation, producer
tools, server transactions, Monaco reconciliation, and review UI behavior.

## Decision

### D1 - One tri-state policy over the existing three modes

The machine values remain exactly:

- `governed-assist`, displayed as **Ask for approval**
- `supervised-coding`, displayed as **Approve for me**
- `autonomous-delivery`, displayed as **Full access**

The exact descriptions are contract data in `CODING_WORKBENCH_MODE_POLICIES`. No second mode or risk
taxonomy is introduced. Policy reuses `CodingWorkbenchApprovalRisk` (`low`, `medium`, `high`,
`critical`) and adds only the closed resource scopes `workspace-contained`, `external-file`,
`internet`, and `delivery` plus the effects `allowed`, `approval-required`, and `denied`.

The complete mode policy is:

| Mode | Workspace-contained | External-file | Internet | Delivery |
| --- | --- | --- | --- | --- |
| Ask for approval | all risks allowed | all risks approval-required | all risks approval-required | all risks approval-required |
| Approve for me | low/medium allowed; high/critical approval-required | low/medium allowed; high/critical approval-required | low/medium allowed; high/critical approval-required | all risks approval-required |
| Full access | all risks allowed | all risks allowed | all risks allowed | all risks approval-required |

The legacy class ceiling is corrected consistently for all three modes: every
`CODING_WORKBENCH_ACTION_CLASSES` value is class-admissible, and `allowsWorkspaceWrites`,
`allowsCommandExecution`, and `allowsDeliverySubstrate` are true. These booleans mean an action can
be represented and evaluated; they do not mean it is pre-approved. The tri-state resource
evaluator, not the legacy class gate, determines whether external-file, internet, or delivery work
needs approval. Runtime adoption of that evaluator is deferred to a later child.

Independent gates combine with **stricter wins**: `denied` is stricter than `approval-required`,
which is stricter than `allowed`. Missing, invalid, or expired authority; unsupported actions;
secret exfiltration; and platform restrictions are denied regardless of mode. Invalid, expired, or
consumed one-use approvals are denied. Commit, push, pull-request, and merge actions remain denied
or separately human-approved delivery actions. Unknown or missing mode values still fall back to
`governed-assist`, and the effective mode remains capped by the deployment ceiling.

### D2 - Dock onto the existing editor-agent control plane

Agent producers call the existing `/api/editor/agent/*` route family and reuse the existing session
registry, bounded queue, idempotency handling, SSE events, and browser bridge. This decision creates
no second transport, session model, control plane, or external-file broker.

`EditorAgentAction` gains optional, content-free references:

- `authorityRef`: run id plus SHA-256 Authority Envelope digest.
- `approvalRef`: approval id, bound action id, proof digest, and expiry. The server later consumes
  this reference once; the contract never carries a reusable bearer secret.

Both fields stay optional so existing schema-version-`1` actions validate unchanged. Missing or
invalid authority is a governance outcome, not a reason to reinterpret old V1 payloads.

### D3 - `applyChangeset` is one bounded, fail-closed action

`applyChangeset` is a new content-mutation action with:

- one action-level `idempotencyKey`, with per-file idempotency keys rejected;
- one UTF-8 patch capped by `EDITOR_AGENT_CHANGESET_MAX_PATCH_BYTES` (65,536 bytes);
- one non-empty, unique file list capped by `EDITOR_AGENT_CHANGESET_MAX_FILES` (50 files);
- a workspace-relative path and at least one version/hash precondition for every file; and
- optional, unique `selectedFiles` drawn only from the declared file list.

`selectedFiles` represents partial acceptance. Absence means the complete declared changeset;
presence means the selected non-empty subset. It does not weaken validation: the server must parse,
contain, policy-check, secret-check, and verify preconditions for the whole submitted action before
any file is eligible. Any unverifiable action or file precondition fails the whole action closed and
applies nothing. After selection, the selected subpatch is derived and revalidated before one atomic
transaction; a selected transaction either applies every selected file or rolls back every file.

The later server implementation routes this through the existing `keiko-tools` patch validation and
atomic apply/rollback path. Closed files may be changed by that governed server workspace
transaction after the mode and Authority Envelope permit it. Open or dirty files remain governed by
the live snapshot: version/hash and dirty-state conflicts are file-attributed, and successful server
results trigger browser Monaco reconciliation so an open buffer cannot silently remain stale.
Browser reconciliation is not a second apply engine.

Normal contained edits and saves do not gain a new per-action review merely because they are editor
actions. When the mode matrix yields `approval-required`, the one-use approval is the gate. The
human's explicit local activation of the task, mode, and Authority Envelope remains the local action
that establishes bounded authority; no mode authorizes work outside that envelope.

Results gain bounded file-attributed entries with `succeeded`, `failed`, `conflict`, or
`not-selected` status, and conflict details may name a contained file. The file result list shares
the 50-file cap. This supports conflict review and partial acceptance without raw patch content in
results or evidence.

### D4 - Bounded diagnostics and live editor context

`EditorAgentSessionSnapshot` keeps the counts-only `diagnosticsSummary` and gains optional
`diagnosticsDetail`. Each item contains only severity, an existing `LanguageRange`, and a message.
The list is capped by `EDITOR_AGENT_DIAGNOSTICS_MAX_ITEMS` (128), each message is capped by
`EDITOR_AGENT_DIAGNOSTIC_MESSAGE_MAX_CHARS` (1,024 characters), and `truncated` is mandatory when
detail is present. Runtime guards reject malformed or oversized detail.

Coding context gains the additive `editor-state` pack source, tiered as
`first-party-workspace`. It is distinct from `files-focus`, which remains an explicit-path disk-read
source. A later provider derives editor-state context from the live `EditorAgentSessionSnapshot`:
active file, selection, dirty set, and bounded diagnostics. Content-bearing excerpts remain
server-internal and redacted; citations and evidence remain content-free.

`editor-state` is added directly to `CodingContextSourceKind`, `CODING_CONTEXT_SOURCE_KINDS`, and the
total tier map. `CodingContextCitation` and `CodingContextOmission` therefore represent editor-state
provenance directly. Exhaustive consumers must add the new source; no compatibility side-union may
hide that contract change.

### D5 - Policy effects drive enforcement, not audit-only labels

The editor's existing disposition vocabulary remains for compatibility. A total mapping projects
central policy effects as follows:

- `allowed` -> `allowed`
- `approval-required` -> `review-required`
- `denied` -> `denied`

`applyChangeset` maps to `content-mutation`. Closed reason codes cover missing/invalid/expired
authority, invalid/expired/consumed approval references, unsupported actions, secret exfiltration,
platform restrictions, mode/risk approval, and separately approved delivery. The existing
classifier is not rewired in this issue; later runtime work must evaluate the central matrix and
enforce the resulting effect before queueing or applying.

Audit and evidence remain redacted and body-free: ids, digests, modes, effects, reason codes,
contained file labels, counts, byte counts, statuses, and hashes only. Patch bodies, diagnostics
messages, file contents, prompts, credentials, command logs, and private endpoints do not enter
governance evidence.

### D6 - Schema compatibility

`EDITOR_AGENT_SCHEMA_VERSION`, `EDITOR_AGENT_AUDIT_SCHEMA_VERSION`,
`CODING_WORKBENCH_SCHEMA_VERSION`, and `CODING_CONTEXT_SCHEMA_VERSION` remain `"1"`. All fields added
to existing V1 envelopes are optional, and `applyChangeset` is a new action variant with its own
required shape. Existing V1 snapshots, actions, results, and context contracts continue to validate.
Every new editor-agent wire shape has a runtime guard.

## Human-control invariant

This decision changes obsolete blanket review semantics; it does not remove human control. A local
human explicitly selects or accepts the task, mode, Authority Envelope, and deployment ceiling.
Keiko then acts only inside that validated authority. Invalid or expired authority fails closed.

Commit, push, pull-request creation, merge, and authority-envelope widening are not ordinary file or
network operations. They remain hard-denied or require a separate explicit local human approval.
No contract in this issue performs a write, bypasses review, launches a process, or grants network
access by itself.

## Consequences

- Mode labels and approval behavior have one shared, testable contract matrix.
- Ask for approval permits normal contained coding work instead of behaving as read-only mode.
- Multi-file and closed-file changes can use one governed atomic server transaction in later work.
- Partial acceptance, diagnostics detail, and file conflicts are representable without schema churn.
- Runtime consumers must adopt the tri-state evaluator and transaction/reconciliation design in
  later children; contract availability alone does not make `applyChangeset` executable.
- New named symbols are additive module exports. Root barrel/package-surface changes are outside this
  issue's owned files and must be handled by the integration owner if public root imports are needed.

## Alternatives considered

### Keep Ask for approval read-only

Rejected. It contradicts the maintained product semantics and turns approval into a blanket
workspace-edit prohibition.

### Add a second editor-specific mode or risk taxonomy

Rejected. Editor policy reuses the existing three machine modes and four approval risks.

### Keep all application in the browser

Rejected for multi-file closed files. The browser cannot atomically transact closed workspace files;
the existing governed server patch transaction owns that operation, with Monaco reconciliation for
open files.

### Validate only selected files

Rejected. A hostile or stale unselected file could otherwise hide an invalid whole action. Whole
action validation remains fail-closed before selected-file projection.
