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

## Context

Issues #1394 ([ADR-0058](ADR-0058-safe-apply-edits-and-patch-workflow.md)), #1391
([ADR-0059](ADR-0059-agent-editor-public-contracts.md)), #1392
([ADR-0060](ADR-0060-agent-editor-session-registry-and-queue.md)), and #1393
([ADR-0061](ADR-0061-browser-editor-agent-bridge.md)) together define the agent editor control
plane: a frozen, schema-versioned wire contract; server-side BFF preflight, queueing, and SSE
liveness; and a browser bridge that executes the nine-action protocol
(`openFile`, `focusTab`, `moveTab`, `splitPane`, `setSelection`, `format`, `save`,
`applyTextEdits`, `applyPatch`).

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
three-way decision taxonomy used by `voice-action-governance` and memory capture. Each of the nine
action types is mapped to an `EditorAgentActionEffectClass`
(`navigation` | `layout` | `content-mutation` | `external-effect`) by a frozen table. The
`external-effect` class is defined for the future Git/command action types but has no members in the
current contract.

A pure, deterministic, fail-closed classifier `classifyEditorAgentAction(type, context)` returns a
disposition plus a content-free reason code:

- `navigation` / `layout` → `allowed`.
- `content-mutation` whose target escapes the workspace root **or** matches the always-on
  workspace deny-list → `denied` (reason `workspace-boundary-escape` / `denied-sensitive-path`).
- `content-mutation` otherwise → `review-required` (reason `content-mutation-requires-review`):
  the action is admitted to the queue and the existing #1394 browser diff-review (Accept/Reject)
  is the human review gate.
- `external-effect` (the future Git/command class, no members today) → `review-required` (reason
  `external-effect-requires-review`): never `allowed` by default. This is the fail-closed posture —
  the effect-class table is exhaustive at compile time (`Record<EditorAgentActionType, …>`), so any
  future mutating action type must be assigned a class explicitly and the only mutating classes
  default to a human gate, never to `allowed`.

Containment reuses the existing `isContainedAgentPath` contract guard. Sensitivity reuses
`keiko-workspace`'s always-on `isDenied` deny-list (`.env`, `.ssh`, `.keiko`, credentials, etc.);
because `keiko-contracts` is a leaf package it cannot import `keiko-workspace`, so the server
computes the `targetSensitive` boolean and passes it into the pure classifier.

The classifier does **not** re-check #1394 structural preconditions (version/hash/overlap); it
governs policy posture only, respecting those gates as upstream preconditions. Issue #2119 adds the
resolved action origin to the decision for audit propagation; origin does not change disposition.

### D2 — Bounded, content-free audit record; in-memory session-scoped ledger

`editor-agent-governance.ts` also defines `EditorAgentActionAuditRecord`
(`EDITOR_AGENT_AUDIT_SCHEMA_VERSION = "1"`), a content-free envelope modelled on
`MemoryAuditEvent` and `patchApplyEvidence`: `auditId`, `occurredAt`, `sessionId`, `actionId`,
`actionType`, bounded `origin`, `effectClass`, `mutating`, `disposition`, optional
`denyReason`/`reviewReason`, `outcome` (the existing `EditorAgentActionStatus`), optional
`conflictCode`/`failureCode`, an optional workspace-relative `targetPath`, content-free counts
(`editCount`, `patchByteLength`), and a bounded, redacted `summary` (≤
`EDITOR_AGENT_AUDIT_SUMMARY_MAX_CHARS`). The pure builder accepts only bounded inputs — it never
receives `textEdits` content, a patch body, a prompt, or a selection body — so the record
_structurally cannot_ carry raw producer content. The server additionally runs the record through
`keiko-security`'s `createAuditRedactor` + `deepRedactStrings` (defense-in-depth) before it enters the
ledger, scrubbing any secret-shaped substring.

The origin property is additive and optional in the V1 record type. The builder always emits a
resolved value: explicit `chat` stays `chat`; omitted legacy action/decision values become `agent`.
Origin is caller-asserted, bounded audit annotation rather than provenance attestation. It never
grants authority, satisfies approval, changes risk, or affects policy disposition.

Storage decision: a **bounded in-memory, per-session, append-only ledger** in the BFF
(`agentActionAudit.ts`), FIFO-evicted (bounded entries per session, bounded session count, mirroring
the existing idempotency map). It is surfaced read-only over `GET /api/editor/agent/audit`. Durable
`EvidenceStore` persistence is intentionally **out of scope** for #1395 (the issue excludes
long-term telemetry collection and SIEM export); the record shape is deliberately
`EvidenceStore`-compatible so a future durable sink can reuse it without a schema change.

An audit record is recorded for every action whose effect class is `content-mutation` (the mutating
set, AC1) and for any action that is `denied`. Navigation/layout `allowed` actions are not audited,
keeping the ledger focused on governance-relevant activity.

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
`voice-action-governance` three-way disposition precedent, the `isContainedAgentPath` /
`isDenied` scope primitives, the existing BFF SSE fan-out, and the existing #1394 browser diff-review
as the human "review-required" gate. The only net-new subsystems are the policy classifier, the
bounded audit record + ledger, and the read-only UI panel.

## Consequences

- The agent editor gains an explicit, testable allow/deny/review-required policy and a bounded audit
  trail without weakening any existing structural gate. The sensitive-path denial is a strict
  security strengthening: `applyTextEdits`/`save`/`format` to a deny-listed path (e.g. `.env`) were
  previously blocked only on the patch path and are now denied across all write actions, surfaced as
  the existing `OUT_OF_SCOPE` conflict so no new wire conflict code is introduced.
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

- **Add `POLICY_DENIED` / `REVIEW_REQUIRED` wire conflict codes.** Rejected: the
  `EditorAgentConflictCode` table is a ratified contract surface; reusing `OUT_OF_SCOPE` for the
  sensitive-path denial avoids contract churn and keeps the browser's exhaustive conflict switch
  stable. The fine-grained governance reason lives in the audit record, not the wire code.
- **Durable `EvidenceStore` persistence now.** Deferred: out of scope per the issue (no long-term
  telemetry); it would require threading an evidence store + redactor through the action route. The
  record shape is kept compatible so this is a clean future addition.
- **Emit audit over a new SSE `editor-agent:audit` event.** Rejected for this issue: it widens the
  frozen `EditorAgentEvent` union and its exhaustive consumers; re-fetch-on-activity over the
  existing event stream delivers the same live-update behaviour with no contract change.
