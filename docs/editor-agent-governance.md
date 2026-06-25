# Agent editor action governance, policy, and audit

This is the governance layer over the agent editor control plane. It makes every agent editor action
**classifiable** (allowed, denied, or review-required) and **auditable** (a bounded, content-free
record of what an agent changed or attempted), and surfaces recent activity to the user. It is
defined in
[`packages/keiko-contracts/src/editor-agent-governance.ts`](../packages/keiko-contracts/src/editor-agent-governance.ts),
enforced and recorded in the BFF
([`agentRoutes.ts`](../packages/keiko-server/src/editor/agentRoutes.ts) +
[`agentActionAudit.ts`](../packages/keiko-server/src/editor/agentActionAudit.ts)), and displayed by the
browser panel
([`EditorAgentActionsPanel.tsx`](../packages/keiko-ui/src/app/components/desktop/widgets/cards/EditorAgentActionsPanel.tsx)).
The governing decision record is
[ADR-0062](./adr/ADR-0062-agent-editor-action-governance-and-audit.md); it builds on the action
contract ([ADR-0059](./adr/ADR-0059-agent-editor-public-contracts.md)), the safe apply-edits gates
([ADR-0058](./adr/ADR-0058-safe-apply-edits-and-patch-workflow.md)), the session registry/queue
([ADR-0060](./adr/ADR-0060-agent-editor-session-registry-and-queue.md)), and the browser bridge
([ADR-0061](./adr/ADR-0061-browser-editor-agent-bridge.md)).

Owner: Issue #1395 (Epic #1491). This is the product differentiator: not just agent power, but
controlled, explainable, recoverable agent power.

## Effect classes

Every action type maps to exactly one effect class
(`EDITOR_AGENT_ACTION_EFFECT_CLASS`, a `Record` keyed by action type so the table is exhaustive at
compile time):

| Effect class       | Action types                                     | Audited | Default disposition |
| ------------------ | ------------------------------------------------ | ------- | ------------------- |
| `navigation`       | `openFile`, `focusTab`, `setSelection`           | no      | `allowed`           |
| `layout`           | `moveTab`, `splitPane`                           | no      | `allowed`           |
| `content-mutation` | `format`, `save`, `applyTextEdits`, `applyPatch` | yes     | `review-required`   |
| `external-effect`  | _(future Git / command actions — none today)_    | yes     | `review-required`   |

The mutating set (`isMutatingEditorAgentAction`) is `content-mutation` ∪ `external-effect`. The issue
scope names Git actions and command-execution references "when available"; the action contract defines
no such action types on this branch, so `external-effect` is declared but empty. When concrete
Git/command actions are added later, each must be assigned an effect class explicitly, and the only
mutating classes default to a human gate (`review-required`), never to `allowed` — the fail-closed
posture.

## Policy taxonomy

`classifyEditorAgentAction(type, context)` is a pure, deterministic, fail-closed classifier returning
an `EditorAgentActionDisposition` and a content-free reason:

- `navigation` / `layout` → **allowed**.
- `content-mutation` whose resolved target escapes the workspace root → **denied**
  (`workspace-boundary-escape`).
- `content-mutation` whose resolved target matches the always-on workspace deny-list → **denied**
  (`denied-sensitive-path`).
- `content-mutation` otherwise → **review-required** (`content-mutation-requires-review`): the action
  is admitted to the queue and the existing browser diff-review (Accept/Reject, ADR-0058) is the human
  review gate.
- `external-effect` → **review-required** (`external-effect-requires-review`).

The classifier governs **policy posture only**. It does not re-check the structural preconditions
(version/hash/overlap/dirty) owned by ADR-0058/0059; those remain upstream gates. Determinism is a
requirement: the same `(type, context)` always yields the same decision, so the policy is replay-safe
and the audit is reproducible.

### Reuse

Containment reuses the existing `isContainedAgentPath` contract guard. Sensitivity reuses
`keiko-workspace`'s always-on `isDenied` deny-list (`.env`, `.ssh`, `.keiko`, credentials, …). Because
`keiko-contracts` is a leaf package it cannot import `keiko-workspace`, so the BFF computes the
`targetSensitive` boolean and passes it into the pure classifier. The three-way disposition mirrors
the established `voice-action-governance` taxonomy.

### Enforcement

The sensitive-path denial is enforced in the BFF preflight (`sensitivePathConflict`): a write action
whose contained target matches the deny-list is refused across **all** write action types
(`format` / `save` / `applyTextEdits` / `applyPatch`). Previously the deny-list was checked only on
the `applyPatch` path via `validatePatch`; this closes the gap and is a strict security strengthening.
It is surfaced as the existing `OUT_OF_SCOPE` conflict code (no new wire code); the fine-grained
governance reason (`denied-sensitive-path` vs `workspace-boundary-escape`) lives in the audit record.

## Audit record

`EditorAgentActionAuditRecord` (`EDITOR_AGENT_AUDIT_SCHEMA_VERSION = "1"`) is content-free by
construction. The pure builder `buildEditorAgentActionAuditRecord` accepts only enums, counts,
identifiers, a workspace-relative path, and a bounded summary — it is never handed `textEdits` content
or a patch body, so the record **cannot** carry raw source text. Fields:

- identity: `auditId`, `occurredAt`, `sessionId`, `actionId`;
- classification: `actionType`, `effectClass`, `mutating`, `disposition`, optional `denyReason` /
  `reviewReason`;
- outcome: `outcome` (`queued` / `succeeded` / `failed` / `conflict`), optional `conflictCode` /
  `failureCode`;
- bounded metadata: optional workspace-relative `targetPath`, content-free counts (`editCount`,
  `patchByteLength`), and a redacted `summary` (≤ `EDITOR_AGENT_AUDIT_SUMMARY_MAX_CHARS`).

### No raw source, no secrets (defense in depth)

Three independent guarantees:

1. **By construction** — the builder input type has no field that can hold raw source text or an edit
   body. `editCount` is the number of edits, not their content; `patchByteLength` is a length, not a
   patch.
2. **By redaction** — the BFF runs every record through `keiko-security`'s `deepRedactStrings` +
   `redact` before it enters the ledger, scrubbing any secret-shaped substring (bearer/API-key/GitHub/
   AWS/Slack/Stripe/PEM shapes) from the path or summary.
3. **By validation** — `isEditorAgentActionAuditRecord` enforces the bounded summary length and valid
   enum members at the read boundary.

## Storage and integration

The BFF holds a **bounded, in-memory, per-session, append-only ledger** (`agentActionAudit.ts`),
FIFO-evicted (100 records per session, 256 sessions). It is recorded synchronously at the action's
admission decision for every action that is mutating or denied (allowed navigation/layout actions are
not recorded). It is surfaced read-only over `GET /api/editor/agent/audit?sessionId=`.

This is intentionally ephemeral: the issue excludes long-term telemetry collection and SIEM export.
The record shape is deliberately `EvidenceStore`-compatible so a future durable sink (mirroring
`patchApplyEvidence`) can persist it without a schema change.

## UI surface

`EditorAgentActionsPanel` renders the recent records for the active session: action type, target
file, a disposition label (allowed / review-required / denied), outcome, and a timestamp. It fetches
the audit feed on mount and re-fetches whenever the editor-agent bridge observes activity
(`onAgentActivity`), without widening the frozen `EditorAgentEvent` union. The disposition is conveyed
by a text label (not colour alone, WCAG 1.4.1), the list is an `aria-live` region, and styling reuses
existing design tokens (no global stylesheet change; CSP `script-src 'self'` compliant).

## Limitations

- **Ephemeral audit.** The ledger is in-memory, session-scoped, and FIFO-evicted; records do not
  survive a server restart and older records are dropped. It backs a "recent actions" view, not a
  compliance archive. Durable persistence is a documented follow-up.
- **Git / command actions are future work.** The taxonomy defines an `external-effect` class for them,
  but no audit fires until those action types exist in the action contract.
- **Lexical containment.** Workspace containment is lexical (`isContainedAgentPath`) plus the always-on
  deny-list; symlink realpath escape is handled by the workspace discovery layer, not re-checked here.
- **Fixed deny-list.** The deny-list is the always-on `keiko-workspace` set; user-configurable
  per-workspace policy is out of scope for this issue.
