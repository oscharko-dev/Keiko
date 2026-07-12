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
The governing decision records are
[ADR-0062](./adr/ADR-0062-agent-editor-action-governance-and-audit.md) and its current authority
amendment, [ADR-0125](./adr/ADR-0125-governed-agent-docking-and-editor-changesets.md). They build on
the action contract ([ADR-0059](./adr/ADR-0059-agent-editor-public-contracts.md)), the safe
apply-edits gates ([ADR-0058](./adr/ADR-0058-safe-apply-edits-and-patch-workflow.md)), the session
registry/queue ([ADR-0060](./adr/ADR-0060-agent-editor-session-registry-and-queue.md)), and the
browser bridge ([ADR-0061](./adr/ADR-0061-browser-editor-agent-bridge.md)).

Owner: Issue #1395 (Epic #1491). This is the product differentiator: not just agent power, but
controlled, explainable, recoverable agent power.

## Effect classes

Every action type maps to exactly one effect class
(`EDITOR_AGENT_ACTION_EFFECT_CLASS`, a `Record` keyed by action type so the table is exhaustive at
compile time):

| Effect class       | Action types                                                       | Audited | Security baseline                                                          |
| ------------------ | ------------------------------------------------------------------ | ------- | -------------------------------------------------------------------------- |
| `navigation`       | `openFile`, `focusTab`, `setSelection`                             | no      | `allowed`                                                                  |
| `layout`           | `moveTab`, `splitPane`                                             | no      | `allowed`                                                                  |
| `content-mutation` | `format`, `save`, `applyTextEdits`, `applyPatch`, `applyChangeset` | yes     | `allowed` when contained and non-sensitive, then composed with mode policy |
| `external-effect`  | _(future Git / command actions — none today)_                      | yes     | `review-required`                                                          |

The mutating set (`isMutatingEditorAgentAction`) is `content-mutation` ∪ `external-effect`. The
action contract currently defines no Git or command action, so `external-effect` remains empty.
Adding one requires an explicit class, resource scope, risk, producer, enforcement path, and tests;
classification alone never grants execution authority.

## Policy taxonomy

`classifyEditorAgentAction(type, context)` is a pure, deterministic classifier that establishes the
mode-independent security baseline and a content-free reason:

- `navigation` / `layout` → **allowed**.
- `content-mutation` whose resolved target escapes the workspace root → **denied**
  (`workspace-boundary-escape`).
- `content-mutation` whose resolved target matches the always-on workspace deny-list → **denied**
  (`denied-sensitive-path`).
- `content-mutation` otherwise → baseline **allowed**.
- `external-effect` → **review-required** (`external-effect-requires-review`).

`composeEditorAgentActionPolicyDecision` then maps the concrete action to the shared Coding Workbench
resource/risk matrix and chooses the stricter result (`denied` > `approval-required` > `allowed`):

| Mode                 | Workspace-contained                                 | External file / internet                            | Delivery                    |
| -------------------- | --------------------------------------------------- | --------------------------------------------------- | --------------------------- |
| **Ask for approval** | all risks allowed                                   | all risks approval-required                         | all risks approval-required |
| **Approve for me**   | low/medium allowed; high/critical approval-required | low/medium allowed; high/critical approval-required | all risks approval-required |
| **Full access**      | all risks allowed                                   | all risks allowed inside the validated envelope     | all risks approval-required |

For editor actions, `format` and `save` are low risk, `applyTextEdits` and `applyPatch` are medium
risk, and `applyChangeset` is high risk. Structural preconditions (version/hash/overlap/dirty), live
bridge capability, Authority Envelope validity and budget, realpath containment, and transaction
checks remain independent gates. The same `(type, context, authority)` yields the same policy result,
so admission is replay-safe and audit is reproducible.

### Reuse

Containment reuses the existing `isContainedAgentPath` contract guard. Sensitivity reuses
`keiko-workspace`'s always-on `isDenied` deny-list (`.env`, `.ssh`, `.keiko`, credentials, …). Because
`keiko-contracts` is a leaf package it cannot import `keiko-workspace`, so the BFF computes the
`targetSensitive` boolean and passes it into the pure classifier. The three-way disposition mirrors
the established `voice-action-governance` taxonomy. Mode, resource, risk, and effect vocabulary come
directly from `CODING_WORKBENCH_MODE_POLICIES`; the editor does not maintain a second autonomy policy.

### Enforcement

The BFF composes the baseline and mode policy before queueing. A policy-required review is admitted
only for an action with an implemented review path (`applyPatch` or `applyChangeset`); other action
types fail closed as `APPROVAL_REQUIRED`. An allowed patch or changeset may proceed without visible
review, but uses the same current-hash check, bridge confirmation, server-side revalidation, atomic
transaction, terminal result, and Monaco reconciliation as the reviewed path. Omitted legacy
`requiresReview` values still mean review-required.

Sensitive-path denial applies across every write action, including every declared member of an
`applyChangeset`. It is surfaced as the existing `OUT_OF_SCOPE` conflict code; the fine-grained
governance reason (`denied-sensitive-path` vs `workspace-boundary-escape`) stays in the audit record.

## Audit record

`EditorAgentActionAuditRecord` (`EDITOR_AGENT_AUDIT_SCHEMA_VERSION = "1"`) is content-free by
construction. The pure builder `buildEditorAgentActionAuditRecord` accepts only enums, counts,
identifiers, a workspace-relative path, and a bounded summary — it is never handed `textEdits` content
or a patch body, so the record **cannot** carry raw source text. Fields:

- identity: `auditId`, `occurredAt`, `sessionId`, `actionId`;
- classification: `actionType`, bounded `origin` (`agent` or `chat`), `effectClass`, `mutating`,
  `disposition`, optional `denyReason` / `reviewReason`;
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
- **Layered containment.** `isContainedAgentPath` is only the first lexical gate. Server preflight and
  commit-time patch handling re-resolve targets through the workspace boundary, reject symlink and
  hard-link escape, and revalidate the atomic transaction before disk mutation.
- **Fixed deny-list.** The deny-list is the always-on `keiko-workspace` set; user-configurable
  per-workspace policy is out of scope for this issue.
