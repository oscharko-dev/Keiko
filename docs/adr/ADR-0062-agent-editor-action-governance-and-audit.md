# ADR-0062: Agent editor action governance, policy, and bounded audit

## Status

Accepted

> **Superseded in part by [ADR-0125](ADR-0125-governed-agent-docking-and-editor-changesets.md).**
> Contained content mutation is not blanket `review-required`. The central mode/resource/risk policy
> effect is enforced and then mapped to the existing editor disposition; audit remains bounded and
> redacted.

> **Amended by Issue #2119 (2026-07-10).** Governance and audit carry the bounded action origin
> (`agent | chat`), defaulting omitted legacy values to `agent`. The existing bounded,
> workspace-relative `targetPath` audit metadata remains unchanged.

> **Amended by Epic #2091 trust-path hardening (2026-07-10).** Policy and audit derive active-buffer
> targets from the verified live snapshot rather than caller-claimed metadata. Wire identifier and
> target-path byte bounds make the count-bounded in-memory ledger byte-bounded as well; capability
> plaintext and digests never enter audit records.

> **Amended by Issue #2121 (2026-07-10).** The classifier now establishes immutable editor security
> posture, then composes it with ADR-0125's shared mode/resource/risk matrix. Contained, non-sensitive
> mutations are baseline-allowed; the composed mode effect may require approval. Workspace-boundary
> and sensitive-path denials remain stricter than every mode. The composed result now drives route
> admission as well as audit.

> **Amended by Issue #2298 (2026-07-11).** Bounded, read-only local repository queries use a
> dedicated `workspace-read` editor effect mapped to the existing Workbench `workspace-read` /
> `workspace-contained` policy vocabulary at low risk. Unlike pure editor navigation/layout, these
> reads require a valid Authority Envelope and consume the existing Authority tool/runtime budgets.
> They remain containment- and sensitive-path-gated, never perform Git mutation, and are neither an
> external/delivery effect nor subject to delivery approval. `queryGit` audit targets are additive,
> bounded basename plus server-computed SHA-256 path metadata; the full target path is omitted, and
> contracts do not compute hashes. This mapping follows the product-wide shared-vocabulary rule in
> [ADR-0129](ADR-0129-product-wide-authority-and-autonomy-model.md); it does not create a
> surface-local authority stack.

## Context

Issues #1394 ([ADR-0058](ADR-0058-safe-apply-edits-and-patch-workflow.md)), #1391
([ADR-0059](ADR-0059-agent-editor-public-contracts.md)), #1392
([ADR-0060](ADR-0060-agent-editor-session-registry-and-queue.md)), and #1393
([ADR-0061](ADR-0061-browser-editor-agent-bridge.md)) together define the agent editor control
plane: a frozen, schema-versioned wire contract; server-side BFF preflight, queueing, and SSE
liveness; and a browser bridge that executes the ten-action protocol
(`openFile`, `focusTab`, `moveTab`, `splitPane`, `setSelection`, `format`, `save`,
`applyTextEdits`, `applyPatch`, `applyChangeset`).

Issue #1395 closes the remaining governance gap. The control plane validates _structure_ (dirty
buffers, version/hash preconditions, edit overlap, workspace containment) but does not classify the
_governance posture_ of an action, does not record a durable, bounded audit of what an agent
mutated or attempted, and gives the user no surface to inspect recent agent editor activity. The
product differentiator for Keiko's agent editor is "not just agent power, but controlled,
explainable, recoverable agent power"; that requires an explicit policy taxonomy and an
auditable record, both built from existing Keiko governance primitives rather than a parallel stack.

The acceptance criteria for #1395 are:

1. Every mutating agent editor action creates bounded audit metadata.
2. Policy can mark actions allowed, denied, or review-required.
3. Audit metadata avoids raw source text and secrets.
4. Users can inspect what an agent changed or attempted.
5. The governance model reuses existing Keiko evidence/policy systems where possible.

The issue scope names "read snapshots, formatting, save, apply edits, apply patch, Git actions, and
command execution references when available." On this branch the action contract
(`EditorAgentActionType`) defines no Git or command-execution action types; those are future work.
The taxonomy must therefore _define_ a class for external effects but only _wire_ audit and policy
for the action types that exist today.

## Decision

### D1 — Three-way policy disposition reusing the established Keiko governance taxonomy

A new content-free contract leaf `keiko-contracts/src/editor-agent-governance.ts` defines
`EditorAgentActionDisposition = "allowed" | "review-required" | "denied"`, mirroring the proven
three-way decision taxonomy used by `voice-action-governance` and memory capture. Each action type
is mapped to an `EditorAgentActionEffectClass` (`navigation` | `layout` |
`workspace-read` | `content-mutation` | `external-effect` | `execution`) by a frozen table. The
`external-effect` class remains reserved for future delivery-like Git/command action types; the
read-only `queryGit` action is deliberately not in that class.

A pure, deterministic, fail-closed classifier `classifyEditorAgentAction(type, context)` establishes
the action's baseline security posture. Issue #2121 then composes that decision with the shared
Coding Workbench policy:

- `navigation` / `layout` → `allowed`.
- `workspace-read` → the same immutable workspace-boundary and sensitive-path checks, then baseline
  `allowed`; `queryGit` maps to Workbench `workspace-read` / `workspace-contained` at low risk.
- `content-mutation` whose target escapes the workspace root **or** matches the always-on
  workspace deny-list → `denied` (reason `workspace-boundary-escape` / `denied-sensitive-path`).
- `content-mutation` otherwise → baseline `allowed`, then maps to Workbench `workspace-write` /
  `workspace-contained`. `format` and `save` are low risk, `applyTextEdits` and `applyPatch` are
  medium risk, and bounded multi-file `applyChangeset` is high risk.
- `external-effect` (the future Git/command class, no members today) → `review-required` (reason
  `external-effect-requires-review`) and maps to Workbench `delivery-substrate` / `delivery`.

Pure navigation and layout are exempt from the Authority Envelope because they change only editor
UI state. `workspace-read` is non-exempt: the server must resolve a valid Authority Envelope, admit
the existing `workspace-read` action class, and reserve the existing tool-call and elapsed-runtime
budgets before a repository read. For the in-scope classes,
`composeEditorAgentActionPolicyDecision` evaluates the central mode/resource/risk matrix and selects
the stricter effect using `denied > approval-required > allowed`. The baseline decision wins ties so
its specific reason is preserved. Thus an envelope can never loosen containment or sensitive-path
denial, while normal contained edits, saves, and bounded repository reads follow the maintained Ask
for approval, Approve for me, and Full access semantics from ADR-0125. No Git mutation or delivery
approval is introduced by `workspace-read`.

Containment reuses the existing `isContainedAgentPath` contract guard. Sensitivity reuses
`keiko-workspace`'s always-on `isDenied` deny-list (`.env`, `.ssh`, `.keiko`, credentials, etc.);
because `keiko-contracts` is a leaf package it cannot import `keiko-workspace`, so the server
computes the `targetSensitive` boolean and passes it into the pure classifier.

For a multi-file changeset, classification considers every declared target. An escaping member is
preferred as the audit target, then a deny-listed member, so a safe active file cannot mask an
unsafe member in the decision or evidence.

The classifier does **not** re-check #1394 structural preconditions (version/hash/overlap); it
governs policy posture only, respecting those gates as upstream preconditions. Issue #2119 adds the
resolved action origin to the decision for audit propagation; origin does not change disposition.
The route rejects `denied` as `POLICY_DENIED`. A `review-required` action is admitted only when its
action type has the existing explicit browser review (`applyPatch` or `applyChangeset`); otherwise
it is rejected as `APPROVAL_REQUIRED`.

For admitted patch and changeset actions, the server projects the composed disposition into the
additive `requiresReview` emission hint. Policy-required review cannot be disabled by a producer;
the explicit local Chat Apply workflow may request stricter review. The browser applies only an
explicit server-emitted `false` directly and treats omission as review-required for V1
compatibility. Direct and reviewed changesets converge on the same server revalidation, atomic
transaction, terminal result, and Monaco reconciliation path.

Direct patches also converge on the existing terminal-confirmation path before mutation. The
browser repeats the active-buffer hash precondition immediately before dispatch; the server then
re-resolves Authority and repeats patch preflight before acknowledging success. The server-owned
Authority registry atomically reserves cumulative tool calls plus patch or inserted text-edit bytes
and enforces elapsed runtime. Exhaustion is a closed, content-free
`authority-budget-exceeded` denial; idempotent replay does not consume the budget twice.

### D2 — Bounded, content-free audit record; in-memory session-scoped ledger

`editor-agent-governance.ts` also defines `EditorAgentActionAuditRecord`
(`EDITOR_AGENT_AUDIT_SCHEMA_VERSION = "1"`), a content-free envelope modelled on
`MemoryAuditEvent` and `patchApplyEvidence`: `auditId`, `occurredAt`, `sessionId`, `actionId`,
`actionType`, bounded `origin`, `effectClass`, `mutating`, `disposition`, optional
`denyReason`/`reviewReason`, `outcome` (the existing `EditorAgentActionStatus`), optional
`conflictCode`/`failureCode`, an optional workspace-relative `targetPath`, optional bounded
`targetBasename` and lowercase SHA-256 `targetPathHash`, content-free counts (`editCount`,
`patchByteLength`), and a bounded, redacted `summary` (≤
`EDITOR_AGENT_AUDIT_SUMMARY_MAX_CHARS`). The pure builder accepts only bounded inputs — it never
receives `textEdits` content, a patch body, a prompt, or a selection body — so the record
_structurally cannot_ carry raw producer content. The server additionally runs the record through
`keiko-security`'s `createAuditRedactor` + `deepRedactStrings` (defense-in-depth) before it enters the
ledger, scrubbing any secret-shaped substring. For `queryGit`, the server computes and supplies the
basename/hash metadata and the builder omits `targetPath`; the contracts package performs no hash
computation and carries no diff, blame, or file body.

The origin property is additive and optional in the V1 record type. The builder always emits a
resolved value: explicit `chat` stays `chat`; omitted legacy action/decision values become `agent`.
Origin is bounded audit annotation rather than authority. Ordinary producer origin remains
caller-asserted. A local capability-backed browser action is canonicalized to `chat` by the server
after live-lease validation. In neither path does origin grant authority, satisfy approval, change
risk, or affect policy disposition.

Storage decision: a **bounded in-memory, per-session, append-only ledger** in the BFF
(`agentActionAudit.ts`), FIFO-evicted (bounded entries per session, bounded session count, mirroring
the existing idempotency map). It is surfaced read-only over `GET /api/editor/agent/audit`. Durable
`EvidenceStore` persistence is intentionally **out of scope** for #1395 (the issue excludes
long-term telemetry collection and SIEM export); the record shape is deliberately
`EvidenceStore`-compatible so a future durable sink can reuse it without a schema change.

An audit record is recorded for every action whose effect class is `content-mutation` (the mutating
set, AC1), for governance-relevant execution and server-resolved reads including `queryGit`, and for
any action that is `denied`. Ordinary navigation/layout `allowed` actions are not audited, keeping
the ledger focused on governance-relevant activity.

### D3 — Read-only "recent agent editor actions" UI surface

A new `EditorAgentActionsPanel` renders the recent records for the active session: action type,
target file, a disposition badge (allowed / review-required / denied), outcome status, and a
relative timestamp. It fetches `GET /api/editor/agent/audit?sessionId=` on mount and re-fetches when
the existing SSE bridge observes an action or result event (no change to the frozen
`EditorAgentEvent` union). It reuses the existing design-system classes and tokens, adds no inline
scripts (CSP `script-src 'self'` compliant), and meets WCAG 2.2 AA (semantic list, `aria-live`,
status conveyed by text not colour alone).

### D4 — Reuse, not reinvention

The governance model reuses: the `MemoryAuditEvent` / `patchApplyEvidence` content-free envelope
pattern, `keiko-security` redaction (`createAuditRedactor`, `deepRedactStrings`), the
`voice-action-governance` three-way disposition precedent, the `isContainedAgentPath` / `isDenied`
scope primitives, the shared Coding Workbench mode/resource/risk matrix, the existing BFF SSE
fan-out, and the existing #1394 browser diff-review when approval is required. The only net-new
subsystems are the policy classifier, the bounded audit record + ledger, and the read-only UI panel.

## Consequences

- The agent editor gains an explicit, testable allow/deny/review-required policy and a bounded audit
  trail without weakening any existing structural gate. The sensitive-path denial is a strict
  security strengthening: `applyTextEdits`/`save`/`format` to a deny-listed path (e.g. `.env`) were
  previously blocked only on the patch path and are now denied across all write actions. Structural
  path violations remain `OUT_OF_SCOPE`; authority or composed-policy denial is `POLICY_DENIED`.
- The audit record is content-free by construction and by redaction; raw source text, patch bodies,
  prompt/selection bodies, and secrets cannot reach the ledger or the UI. The bounded,
  workspace-relative target path remains inspectable metadata.
- Audit consumers can distinguish the agent/harness and chat producers without receiving producer
  content, while legacy actions deterministically audit as `agent`.
- The ledger is ephemeral and bounded; it backs a "recent actions" view, not a compliance archive.
  Durable persistence and Git/command-action governance are documented follow-ups.

## Limitations

- No durable audit persistence (in-memory, session-scoped, FIFO-evicted). Records do not survive a
  server restart and older records are evicted.
- Git actions and command-execution actions are not part of the action contract on this branch; the
  taxonomy defines an `external-effect` class for them but no audit fires until those action types
  exist.
- Workspace containment is lexical (`isContainedAgentPath`) plus the always-on deny-list; symlink
  realpath escape is handled by the existing workspace discovery layer, not re-checked here.
- The deny-list is the always-on `keiko-workspace` set; user-configurable per-workspace policy is not
  part of this issue.

## Alternatives considered

- **Reuse `OUT_OF_SCOPE` for every policy outcome.** Rejected: structural target violations and
  authority/mode denial are different failures. `POLICY_DENIED` and `APPROVAL_REQUIRED` preserve a
  bounded wire distinction while the fine-grained reason remains in the redacted audit record.
- **Durable `EvidenceStore` persistence now.** Deferred: out of scope per the issue (no long-term
  telemetry); it would require threading an evidence store + redactor through the action route. The
  record shape is kept compatible so this is a clean future addition.
- **Emit audit over a new SSE `editor-agent:audit` event.** Rejected for this issue: it widens the
  frozen `EditorAgentEvent` union and its exhaustive consumers; re-fetch-on-activity over the
  existing event stream delivers the same live-update behaviour with no contract change.
