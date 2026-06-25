# ADR-0059: Agent editor public contracts for sessions, snapshots, actions, and events

## Status

Proposed

## Context

Issue #1391 (Epic #1491) owns the public, schema-first API contract that agents and the browser
bridge use to inspect and operate the live editor safely. Its scope is "typed contracts for editor
sessions, snapshot requests, snapshot responses, action requests, action results, events, errors,
idempotency keys, document versions, content hashes, and bounded text modes," and its acceptance
criteria are:

1. Snapshot text defaults to `none`.
2. Write actions require idempotency and version/hash preconditions.
3. Conflict and dirty-state errors are structured.
4. Contracts are reusable by UI, BFF, tests, and future agents.

The contract module already exists. `packages/keiko-contracts/src/editor-agent.ts` was scaffolded by
the agent-native editor foundation (Issue #1296) and extended by the safe apply-edits work (Issue
#1394, ADR-0058). It is attributed to Issue #1391 in the contracts barrel and is already consumed by
the BFF (`packages/keiko-server/src/editor/agentRoutes.ts`), the browser bridge
(`EditorRuntimeWidget.tsx`, `AgentConflictBanner.tsx`, `lib/api.ts`), and the contract/route test
suites. It already provides:

- a versioned envelope (`EDITOR_AGENT_SCHEMA_VERSION = "1"`);
- `EditorAgentSessionSnapshot` (sessions) and `EditorAgentSnapshotRequest` (snapshot requests) with a
  bounded text-mode (`none | selection | activeFile`);
- `EditorAgentAction` (action requests) with a mandatory `idempotencyKey` and optional
  `expectedDocumentVersion` / `expectedContentHash` preconditions;
- `EditorAgentActionResult` (action results) with a structured `conflict` object;
- `EditorAgentEvent` (events: session, action, result, heartbeat);
- content-free document versions (`EditorDocumentVersion`, from `editor-session.ts`) and SHA-256
  content hashes; and
- throw-free validators (`isEditorAgentAction`, `isEditorAgentSessionSnapshot`,
  `isEditorAgentActionResult`, `parseEditorAgentSnapshotRequest`, `parseEditorAgentActionsPostBody`,
  `validateAgentTextEdits`, `isContainedAgentPath`, `isEditorAgentConflictCode`).

Therefore Issue #1391 is **not** a new subsystem. Per the issue's own stop conditions ("Stop if
existing Keiko functionality can satisfy the issue outcome through reuse, extension, or
generalization"), the correct work is to **ratify, harden, version, document, and close** the public
contract so all four acceptance criteria hold with executable evidence — not to build a parallel one.

Against the live criteria, three real gaps remain:

- **AC1 gap**: `parseEditorAgentSnapshotRequest` *rejected* a read request that omitted `textMode`
  instead of defaulting it to the content-free `none`. The criterion calls for a safe-by-default
  projection: an agent that does not opt into text must not receive document content.
- **AC2 gap**: the contract carried `expectedDocumentVersion` / `expectedContentHash` as optional
  fields that the BFF enforced only *when present*. A write action that pinned no revision (a blind
  write) was accepted and queued. The criterion requires the precondition to be present for writes.
- **AC3 / deliverable gap**: the conflict codes existed but the taxonomy was not exported as a named
  type and frozen table, and there were no public API documentation notes, no compatibility test for
  the schema-version constant, and no validator for the event union.

Leaf-package rules apply (ADR-0019, ADR-0042): `editor-agent.ts` holds pure types, frozen const
tables, and throw-free validators only — no `node:*`, no clock, no crypto, no randomness, and no
imports of other `@oscharko-dev/keiko-*` packages beyond the two relative sibling files
`./editor-session.js` and `./language-service.js`. `max-lines-per-function` is 50 for non-test files.
The contracts barrel is re-exported from `@oscharko-dev/keiko-server` and `@oscharko-dev/keiko-ui`;
the **root** barrel does not `export *` from `@oscharko-dev/keiko-contracts`, so adding named exports
here does not change `scripts/root-package-surface.contract.json`.

## Decision

### D1 — Ratify `editor-agent.ts` as the versioned public contract (reuse, not duplicate)

We keep `EDITOR_AGENT_SCHEMA_VERSION = "1"` and the existing shapes as the public, schema-first API.
No type changes shape incompatibly; every addition below is additive (new exports, a widened conflict
union, and a default applied at a parse boundary). A compatibility test pins the version constant.

### D2 — AC1: snapshot text defaults to `none`

We add `DEFAULT_EDITOR_AGENT_SNAPSHOT_TEXT_MODE = "none"` and change the read-request parser so an
omitted `textMode` resolves to that default; a value that is present but is not one of the three
bounded modes is still a hard error. The resolved `EditorAgentSnapshotRequest` therefore always
carries a concrete, safe-by-default mode, and the BFF (`shapeSnapshot`) already strips text for
`none`. An agent that does not explicitly request text never receives document content.

### D3 — AC2: write actions require a version/hash precondition

`idempotencyKey` is already a required field on every action (validated by `isEditorAgentAction`),
which satisfies the idempotency half of the criterion. For the version/hash half we add four pure,
reusable contract helpers:

- `EDITOR_AGENT_WRITE_ACTION_TYPES` — the frozen set of mutating action types (`format`, `save`,
  `applyTextEdits`, `applyPatch`); the single source of truth the BFF reuses in place of a local
  predicate.
- `isEditorAgentWriteActionType(value)` — guard over that set.
- `editorAgentActionHasWritePrecondition(action)` — true when the action pins a revision by document
  version or content hash.
- `editorAgentWritePreconditionError(action)` — returns a stable, content-free error string when a
  write action pins no revision, or `null` otherwise.

The BFF maps the missing-precondition rule onto a new **structured** conflict, `PRECONDITION_REQUIRED`
(see D4), in `preflight()`. The precondition gate runs **last** in the write-conflict chain so a
doubly-invalid write still reports its most specific structural failure (dirty / version / hash /
out-of-scope / invalid-edits), while any otherwise-valid write that pinned no revision is rejected
rather than queued. This closes the lost-update / blind-overwrite gap without weakening any existing
gate. (We keep this a 409 conflict in the same structured channel agents already parse — the HTTP-428
"Precondition Required" semantic — rather than a 400 parse rejection, so it does not conflate
shape-validity with write policy.)

The just-merged Issue #1394 route tests constructed write actions that pinned no revision (they were
exercising the *other* preflight gates before the mandatory-precondition layer existed). Two valid
single-file `applyPatch` queue tests and the F3 file-mismatch test are migrated to pin the snapshot's
revision — the realistic shape an agent sends — so they continue to exercise their target paths; a
dedicated `PRECONDITION_REQUIRED` test block proves the new rule.

### D4 — AC3: structured error-code taxonomy

We extract the inline conflict-code union into an exported `EditorAgentConflictCode` type and an
exported frozen `EDITOR_AGENT_CONFLICT_CODES` table, widened with `PRECONDITION_REQUIRED`:

```
"DIRTY" | "VERSION_MISMATCH" | "CONTENT_HASH_MISMATCH" | "NO_ACTIVE_SESSION"
  | "INVALID_EDITS" | "OUT_OF_SCOPE" | "PRECONDITION_REQUIRED"
```

`isEditorAgentConflictCode` reads from that table. The browser conflict surface
(`AgentConflictBanner`) gains a `PRECONDITION_REQUIRED` title and treats it as Dismiss-only (an agent
error the user cannot self-resolve), consistent with `INVALID_EDITS` / `OUT_OF_SCOPE`. The union
widening is additive; the exhaustive `conflictTitle` switch adds the new case.

### D5 — AC4: reusability and event validation

We add `isEditorAgentEvent`, a structural guard over the full event union (session, action, result,
heartbeat) that validates the shared envelope and each kind's payload, so consumers reading events off
the SSE stream validate frames at the trust boundary instead of casting untyped JSON. The browser
bridge adopts it for the result stream. All new symbols are exported from the contracts barrel and
pinned by the barrel surface test, demonstrating reuse by UI, BFF, tests, and future agents.

## Consequences

### Positive

- All four acceptance criteria are server- and contract-enforced and unit-testable without a browser.
- Snapshot reads are content-free by default; agents opt into text explicitly and within a byte
  budget.
- Blind writes are impossible: a write must pin the revision it expects, closing the lost-update gap.
- The conflict taxonomy is a single exported vocabulary that agents, the BFF, and the UI discriminate
  on without parsing free text.
- "What is a write action" lives once, in the contract, and is reused by the BFF.
- `root-package-surface.contract.json` is unaffected (the contracts barrel is not re-exported from the
  root barrel).

### Negative

- The conflict union widens by one code; downstream exhaustive switches (the conflict banner) must add
  the case. This is the additive-widening cost ADR-0058 already anticipated.
- Write actions that previously queued without a precondition now require one. This is the intended
  hardening, and the realistic agent flow already has the snapshot's version/hash to supply.

### Neutral

- The precondition gate is ordered last so existing structural codes keep priority; a future revision
  could surface "multiple reasons" if agents need it.

## Acceptance criteria mapping

| AC | Where enforced | How |
|----|----------------|-----|
| AC1: snapshot text defaults to `none` | `parseEditorAgentSnapshotRequest` (contract) | omitted `textMode` → `DEFAULT_EDITOR_AGENT_SNAPSHOT_TEXT_MODE`; BFF `shapeSnapshot` strips text for `none` |
| AC2: write actions require idempotency + version/hash | `isEditorAgentAction` (idempotency) + `editorAgentWritePreconditionError` (contract) + `preconditionConflict` (BFF) | mandatory `idempotencyKey`; write without a version/hash precondition → `PRECONDITION_REQUIRED` |
| AC3: structured conflict / dirty-state errors | `EditorAgentConflictCode` + `EDITOR_AGENT_CONFLICT_CODES` (contract); `AgentConflictBanner` (UI) | named taxonomy + frozen table; structured `conflict.code` on every result |
| AC4: reusable by UI, BFF, tests, future agents | contracts barrel + `isEditorAgentEvent` | exported symbols consumed by server, UI, and tests; event guard validates SSE frames |

## Alternatives considered

### Alternative 1: enforce the precondition in `isEditorAgentAction` (400 at parse)

Make a write action structurally invalid unless it pins a revision, so the BFF returns 400 at the
parse boundary.

- **Pros**: no new conflict code.
- **Cons**: conflates shape-validity with write policy; turns the layered, structured-conflict design
  (every safety failure is a 409 `conflict.code`) into a 400; and a missing precondition reads as
  "malformed request" rather than the precise "precondition required" semantic agents key on.
- **Why rejected**: AC3 calls for structured conflicts; a structured `PRECONDITION_REQUIRED` (409,
  HTTP-428 semantic) keeps the failure in the channel agents already parse.

### Alternative 2: treat AC2 as already satisfied (mechanism present, optional)

Read "require ... preconditions" as "the contract provides preconditions, enforced when present," and
ship only tests + docs.

- **Pros**: zero behavior change; no #1394 test migration.
- **Cons**: a blind write (no precondition) still queues, so the lost-update safety property AC2 names
  is not actually guaranteed; "require" is reduced to "support."
- **Why rejected**: the criterion's security intent — no blind writes — is only met if the precondition
  is present for writes.

### Alternative 3: build a new unified agent-editor contract module

Author a fresh, separate contract for sessions/snapshots/actions/events.

- **Pros**: a clean-slate API surface.
- **Cons**: duplicates the live `editor-agent.ts` already consumed by the BFF, UI, and tests; violates
  the issue's reuse stop condition; orphans #1394's work.
- **Why rejected**: reuse-and-harden is mandated; a parallel subsystem is explicitly out of scope.

## Out-of-scope guards

Per the issue, this change adds **no** server queue implementation, **no** browser bridge
implementation, **no** actual patch application, and **no** agent orchestration UI. It only defines
and hardens contracts and the BFF validators that consume them, plus the minimal contract-consumer
updates (one conflict-banner title, one SSE-frame guard adoption) required to keep the workspace green.

## Related

- ADR-0019: Modular package architecture — leaf-rule constraints on `editor-agent.ts`
- ADR-0042: Keiko Editor package and boundaries
- ADR-0058: Safe apply-edits and patch workflow for agents (Issue #1394) — extended the contract this
  ADR ratifies
- Issue #1296: Agent-native editor foundation (scaffolded `editor-agent.ts`)
- `packages/keiko-contracts/src/editor-agent.ts`: the public contract
- `packages/keiko-server/src/editor/agentRoutes.ts`: the BFF validators that consume it
- `docs/editor-agent-contracts.md`: public API semantics notes

## Date

2026-06-25
