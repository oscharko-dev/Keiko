# ADR-0058: Safe apply-edits and patch workflow for agents

## Status

Proposed

> **Superseded in part by [ADR-0125](ADR-0125-governed-agent-docking-and-editor-changesets.md).**
> Per-patch browser review and rejection of multi-file agent patches are no longer universal.
> Mode policy may allow normal contained edits/saves, and governed multi-file closed-file changes use
> the existing atomic server patch transaction with Monaco reconciliation.

## Context

Issue #1394 closes the five open safety gaps in the agent-native editor action path built by Issue
#1296. The gaps are real and confirmed against the current code:

- **AC2 gap**: `applyTextEdits` overlap is caught by `applyTextEditsToText` but reported as a
  generic `failed` status with no structured `conflict.code`; the server `preflight()` in
  `agentRoutes.ts` does not validate edit structure at all.
- **AC3 gap**: DIRTY / VERSION_MISMATCH / CONTENT_HASH_MISMATCH conflicts exist server-side but
  are never surfaced to the user in the editor UI; only the agent sees the conflict result.
- **AC5 gap**: `preflight()` performs no containment check on `action.target.file`; `applyPatch`
  is entirely unimplemented in the browser (`executeAgentAction` returns a generic `failed`).

Three facts from the existing code fix the baseline:

1. `@monaco-editor/react` 4.7.0 (confirmed via `node_modules/@monaco-editor/react/dist/index.js`)
   applies `value` prop changes through `editor.executeEdits` + `editor.pushUndoStop` when the
   editor is not read-only, and through `editor.setValue` when read-only. Because `setContent()`
   in `EditorRuntimeWidget` flows into the `value` prop and agent writes target writable buffers,
   undo/redo is preserved by construction for `applyTextEdits`. AC4 is already met; it requires
   only a regression test, not new wiring.

2. `keiko-tools validatePatch` (packages/keiko-tools/src/patch.ts) accepts an injected `WorkspaceFs`
   (dep.fs) and performs parse → `resolveWithinWorkspace` + `isDenied` + `containedRealPathInfo`
   containment → binary-diff detection → hunk overlap validation, all without writing. It can run
   in `preflight()` by passing `{ fs: deps.fs ?? nodeWorkspaceFs }` — the same pattern the
   existing `patchApplyRoutes.ts` (Issue #1204) uses for validation-only mode.

3. `buildPatchPreview` in `@oscharko-dev/keiko-editor` already translates a patch diff into a
   `{ original, modified }` model for `KeikoDiffEditor`. The Issue #1202 test-generation flow uses
   this exact component for explicit user review before apply. The same review surface satisfies
   both the "reviewable UI state before destructive application" deliverable and AC3 visibility for
   patch conflicts.

The `editor-agent.ts` contract is a leaf package (ADR-0019, ADR-0042): pure types, frozen consts,
throw-free validators only, no `node:*` imports, no keiko-* imports except the two relative sibling
files `./editor-session.js` and `./language-service.js`. Any new validator must stay pure and
throw-free.

The `max-lines-per-function` ESLint rule is set to 50 (error) for all non-test files. Helper
extraction is required wherever a new function would exceed this limit.

The keiko-contracts barrel (`packages/keiko-contracts/src/index.ts`) is re-exported from
`@oscharko-dev/keiko-server` and `@oscharko-dev/keiko-ui`. The root barrel (`src/index.ts`)
does NOT `export *` from `@oscharko-dev/keiko-contracts`; it re-exports keiko-harness,
keiko-model-gateway, keiko-workspace, and keiko-verification. Therefore adding new named exports
to `editor-agent.ts` and the contracts barrel does not change `scripts/root-package-surface.contract.json`.

Out-of-scope items (must be actively guarded, never implemented):

- Automatic merge conflict resolution by model
- Git commit creation
- Applying patches outside the selected workspace root
- Binary file patching

## Decision

### D1 — Contract: two new conflict codes and three pure validators (editor-agent.ts)

We will extend `EditorAgentActionResult.conflict.code` with two new values, making the union:

```
"DIRTY" | "VERSION_MISMATCH" | "CONTENT_HASH_MISMATCH" | "NO_ACTIVE_SESSION"
  | "INVALID_EDITS" | "OUT_OF_SCOPE"
```

We will add three pure throw-free validators to `editor-agent.ts`:

- `validateAgentTextEdits(edits: readonly { range: LanguageRange; newText: string }[]): string | null`
  Returns null on success or an error string. Detects: inverted range (end before start), empty
  edit array accepted, negative line/character coordinates. Does NOT sort or detect overlaps
  (overlap detection requires offset resolution which needs the document text; that lives in
  `applyTextEditsToText`). Returns null for empty arrays (valid no-op).

- `isContainedAgentPath(candidate: string): boolean`
  Pure structural check: returns false if the candidate is empty, starts with `/`, starts with a
  Windows drive letter pattern (`[A-Za-z]:`), contains `..` as a path segment, or contains a NUL
  character. Returns true otherwise. This is the first gate; `resolveWithinWorkspace` on the server
  is the authoritative gate.

- `isEditorAgentConflictCode(value: unknown): value is NonNullable<EditorAgentActionResult["conflict"]>["code"]`
  Type guard over the full five-value union, for test assertions and result validation.

These are the only additions. No types change shape; additions are union-widening (backward
compatible at the receiver). The contracts barrel (`index.ts`) exports all three.

### D2 — Server: three new preflight checks in agentRoutes.ts

We will add three checks to `preflight()` in `packages/keiko-server/src/editor/agentRoutes.ts`,
applied after the existing three checks, in this order:

1. **Containment check** (all write actions with a `target.file`): call `isContainedAgentPath`
   from the contract. If it returns false, return `conflict(action, "OUT_OF_SCOPE", ...)` without
   queuing. This is the fast structural gate before the filesystem call.

2. **Text-edit structural check** (`applyTextEdits` only): call `validateAgentTextEdits` from the
   contract. If it returns an error string, return `conflict(action, "INVALID_EDITS", message)`.
   This catches inverted/negative-coordinate edits before queueing.

3. **Patch validation** (`applyPatch` only): call `validatePatch` from `@oscharko-dev/keiko-tools`
   with an injected `{ fs: nodeWorkspaceFs }` (validate-only, no writer injected) against a
   `WorkspaceInfo` derived from `snapshot.workspaceRoot`. On `validation.ok === false`, map
   rejection codes:
   - `"path-unsafe"` or `"path-denied"` → `conflict(action, "OUT_OF_SCOPE", ...)`
   - `"binary"` → `conflict(action, "OUT_OF_SCOPE", "Binary patches are not supported.")`
   - `"malformed"`, `"size-limit"`, `"line-limit"`, `"file-limit"` → `conflict(action, "INVALID_EDITS", ...)`
   On `validation.conflicts.length > 0` (hunk mismatch) → `conflict(action, "INVALID_EDITS", ...)`
   On `validation.ok === true` → proceed to queue normally.

   `preflight()` imports `validatePatch` from `@oscharko-dev/keiko-tools` (already a dependency of
   keiko-server, confirmed in `packages/keiko-server/package.json`). The `workspaceInfo` is derived
   inline from the session snapshot already retrieved in `preflight()`.

The `preflight()` function body will exceed 50 lines with these additions. We will extract the
three new checks into named private helpers (`containmentConflict`, `textEditsConflict`,
`patchValidationConflict`), each returning `EditorAgentActionResult | null`, mirroring the existing
`dirtyBufferConflict`, `documentVersionConflict`, and `contentHashConflict` helper shape.

The conflict result from preflight is stored in the `idempotency` map (existing behavior unchanged)
and returned as HTTP 409. Idempotent retry of a conflict-producing action replays the cached
conflict result.

### D3 — Browser: structured INVALID_EDITS for applyTextEdits; KeikoDiffEditor review path for applyPatch

**applyTextEdits**: We will extend `postAgentResult` in `EditorRuntimeWidget.tsx` to accept an
optional fourth argument `conflictCode?: NonNullable<EditorAgentActionResult["conflict"]>["code"]`
and include `conflict: { code, message }` in the result body when present. The existing `setContent`
→ `applyTextEditsToText` path remains unchanged (AC4 by construction). The `catch (error)` block
currently calls `postAgentResult(action, "failed", error.message)`. We will change it to:
- If `error instanceof OverlappingPatchEditError` → `postAgentResult(action, "conflict",
  error.message, "INVALID_EDITS")`
- Otherwise → `postAgentResult(action, "failed", ...)`

**applyPatch — "server-validate-only-with-review" model**: The server validates the patch via D2
before queueing. When the browser receives a queued `applyPatch` action via SSE:

1. If `action.target?.file` is not the currently open file in this pane, call
   `postAgentResult(action, "conflict", "Patch targets a file not open in this pane.", "OUT_OF_SCOPE")`.
   Do not attempt application. (Multi-file patches are rejected server-side anyway via single-target
   enforcement in D2 — see D4.)

2. If the target file matches the open buffer, call `buildPatchPreview` (already available from
   `@oscharko-dev/keiko-editor`) to produce `{ original, modified }` and enter the review state:
   set a local `agentPatchPending` state containing `{ action, preview }`. The `KeikoDiffEditor`
   is rendered in place of the normal `EditorSurface` (same pattern as test-generation preview in
   Issue #1202). Two buttons — "Accept" and "Reject" — are rendered below the diff:
   - Accept: compute the text edits that transform `preview.original` to `preview.modified` using
     `applyTextEditsToText` with the normalized hunk edits from `buildPatchPreview`. Call
     `setContent(modified)` directly (reuses the existing AC4 path). Call
     `postAgentResult(action, "succeeded")`. Clear `agentPatchPending`.
   - Reject: call `postAgentResult(action, "failed", "Patch rejected by user.")`. Clear
     `agentPatchPending`.

3. If `buildPatchPreview` throws (malformed after server validation — should not happen in normal
   flow), call `postAgentResult(action, "failed", error.message)`.

The `agentPatchPending` state is a new `useState` holding
`{ action: EditorAgentAction; preview: TestGenerationPreview } | null`. When non-null, the widget
renders `EditorDiffSurface` with `loadState: { status: "ready" }` and the two action buttons.

**Note on multi-file patches**: D2 server validation of `applyPatch` calls `validatePatch` against
the entire patch string. If the patch touches more than one file, `validatePatch` may return `ok:
true` for multi-file patches (keiko-tools supports them). We add an explicit additional server-side
check: if `validation.files.length > 1`, return `conflict(action, "OUT_OF_SCOPE", "Multi-file
patches must be applied outside the agent action path.")`. Single-file patches targeting a file
other than `activeFile` in the snapshot are flagged `OUT_OF_SCOPE` by the same check. This is the
agent action path; multi-file and out-of-active-file writes belong to the #1204 route.

### D4 — Conflict/review UI: AgentConflictBanner component

We will add a new `AgentConflictBanner` component in
`packages/keiko-ui/src/app/components/desktop/widgets/cards/AgentConflictBanner.tsx`.

The banner:
- Renders when `agentConflict` state is non-null (set whenever `executeAgentAction` produces a
  conflict result that the agent cannot self-resolve: DIRTY, VERSION_MISMATCH,
  CONTENT_HASH_MISMATCH, INVALID_EDITS, OUT_OF_SCOPE).
- Displays the conflict code and human-readable message.
- For DIRTY: offers "Save" and "Dismiss" affordances (Save calls `persist(contentRef.current)`;
  on success, clears the banner and the user can re-trigger the agent). Dismiss closes the banner.
- For VERSION_MISMATCH / CONTENT_HASH_MISMATCH: offers "Reload" and "Dismiss" (Reload calls
  `reload()`).
- For INVALID_EDITS / OUT_OF_SCOPE: "Dismiss" only (these are agent errors, not user conflicts).
- Uses existing `.ai-danger` CSS class (confirmed present in globals.css, lines 10155+) as the
  visual container — no new CSS classes required for the banner itself.
- Banner is `role="alert"` for screen-reader announcement.
- `data-testid="agent-conflict-banner"` for browser test targeting.

The banner is rendered above the editor surface, below the tab list, within `EditorRuntimeWidget`.
It does not replace the editor surface (non-destructive: AC3).

A new `agentConflict` state
`useState<{ code: NonNullable<EditorAgentActionResult["conflict"]>["code"]; message: string } | null>(null)`
is added to `EditorRuntimeWidget`. It is set by `executeAgentAction` when the agent receives a
conflict result (the browser can observe these from the SSE stream result events). It is cleared by
the banner's dismiss/save/reload actions.

The `.ai-danger` class reuse avoids any new globals.css additions, so no new globals.css.test.ts
SHA line is needed for the banner. If future styling requires a new `.ed-agent-conflict*` token,
it must be added via the token-proposal-first path (ADR-0050).

### D5 — AC4 regression test

A Playwright browser test in `tests/e2e/editor-agent-1394.spec.ts` verifies undo/redo
preservation. It loads the editor, posts a `applyTextEdits` agent action via the API, observes the
content change, then calls `editor.trigger('keyboard', 'undo', null)` via `page.evaluate()` and
asserts the text reverts. This is the only proof possible for the executeEdits/pushUndoStop claim
(unit tests cannot exercise the Monaco imperative API).

## Consequences

### Positive

- All five ACs become server-enforced and unit-testable without a browser; the server is the
  single authority for safety checks (containment, binary, overlap, dirty, version, hash).
- `OUT_OF_SCOPE` and `INVALID_EDITS` conflict codes are structured and machine-readable; agents
  can discriminate and self-report the failure class without parsing strings.
- `applyPatch` is no longer silently unimplemented; it has a defined, reviewable, undo-preserving
  execution path.
- No new package-graph edges: keiko-tools is already a keiko-server dependency; keiko-editor's
  `buildPatchPreview` is already used by the #1202 test-generation flow.
- No new browser-side unified-diff parser: `buildPatchPreview` is already present in
  `@oscharko-dev/keiko-editor`.
- `root-package-surface.contract.json` is unaffected (keiko-contracts is not re-exported from the
  root barrel).

### Negative

- `applyPatch` requires explicit user Accept before taking effect; this adds a round-trip
  interaction for every patch, even trivially safe ones. This is a deliberate design choice per
  the engineering note ("prefer conservative behavior and explicit user review").
- `postAgentResult` signature gains an optional fourth parameter; callers that currently pass
  three arguments are unaffected, but the function body grows and must stay under 50 executable
  lines (extract helpers if needed).
- The `agentConflict` state and `agentPatchPending` state add two new `useState` entries to
  `EditorRuntimeWidget`, which is already a large component (1821 lines). The developer must
  keep each state handler under the 50-line function gate.
- `preflight()` gains three new private helpers; `agentRoutes.ts` will grow from ~252 to ~330
  lines (still within single-module scope — no split required, but the developer must verify
  no individual function exceeds 50 lines).

### Neutral

- The `KeikoDiffEditor` review surface for `applyPatch` is identical in shape to the test-
  generation preview flow (#1202). Users familiar with the test-generation UX will recognize the
  pattern. A future decision may streamline agent patches after gathering usage evidence.
- New conflict codes are additive union widening; downstream consumers (the agent SDK, the UI
  conflict banner) that use exhaustive switches must add cases.

## Out-of-scope guards

- **Auto-merge**: The "Accept" action for `applyPatch` is a single user-initiated click. There
  is no automatic accept path. The agent cannot trigger accept.
- **Git commit**: No code in this issue touches `git`; the existing "User control" decision in
  docs/adr/README.md (no commits without explicit local action) is unaffected.
- **Outside-workspace apply**: D2's containment check (`isContainedAgentPath` + server-side
  `validatePatch` with `resolveWithinWorkspace`) ensures no path can escape `workspaceRoot`. The
  `OUT_OF_SCOPE` code is returned for any escape attempt, before queuing.
- **Binary file patching**: `validatePatch`'s `isBinaryDiff` check detects `"GIT binary patch"`,
  `"Binary files .. differ"`, and NUL bytes; all map to `OUT_OF_SCOPE` conflict in D2.
- **Multi-file patches via agent action**: D2 explicitly rejects patches with `files.length > 1`
  as `OUT_OF_SCOPE`. Multi-file apply belongs to the #1204 `patchApplyRoutes.ts` flow.

## Acceptance criteria mapping

| AC | Where enforced | How |
|----|---------------|-----|
| AC1: Hash/version mismatch returns structured conflict | Server `preflight()` (existing) | `documentVersionConflict` / `contentHashConflict` → VERSION_MISMATCH / CONTENT_HASH_MISMATCH |
| AC2: Overlapping or invalid edits are rejected | Server `preflight()` (D2) + browser catch (D3) | `patchValidationConflict` → INVALID_EDITS server-side; OverlappingPatchEditError → INVALID_EDITS browser-side |
| AC3: Dirty buffer conflicts are visible and non-destructive | Browser `AgentConflictBanner` (D4) | Banner renders above editor, editor content unchanged, user has Save/Dismiss affordance |
| AC4: Applied edits preserve undo/redo where Monaco supports it | `@monaco-editor/react` value-prop reconciliation (existing) | `executeEdits` + `pushUndoStop` for non-read-only editor; regression test in D5 |
| AC5: No patch can write outside workspace root | Server `preflight()` (D2) | `isContainedAgentPath` (fast structural) + `validatePatch` with `resolveWithinWorkspace` (authoritative) → OUT_OF_SCOPE |

## Alternatives considered

### Alternative 1: Buffer-apply — parse and apply the patch immediately in the browser

The browser receives a queued `applyPatch` action and applies it directly without user review,
using a browser-safe unified-diff parser that converts hunks to `EditorTextEdit[]` and calls
`applyTextEditsToText`.

- **Pros**: Faster agent loop (no user interaction required). Undo-preserving via existing
  `executeEdits` path.
- **Cons**: Requires either a new browser-safe unified-diff parser (new surface, new code to
  maintain and secure) or lifting `keiko-tools`' parser to be browser-importable (it currently
  uses `Buffer.byteLength` and assumes Node.js). The parser is non-trivial: 500+ lines in
  `patch-parse.ts`, `patch-normalize.ts`, `patch-content.ts`. Introduces the parser as a
  security surface in the browser. Provides no review affordance before destructive change
  (violates the engineering note and the "reviewable UI" deliverable).
- **Why rejected**: Duplicates the diff-parsing logic that exists and is gate-tested in
  keiko-tools; introduces new browser-side attack surface; eliminates the mandatory review step
  that the engineering note requires; does not satisfy the "reviewable UI state before destructive
  application" deliverable.

### Alternative 2: Server-side apply — agent applyPatch writes files via a new server endpoint

The agent `applyPatch` action is handled entirely server-side: `preflight()` validates and queues
the action; a new server handler applies the patch via `applyPatch` from `keiko-tools`, then
sends the result via SSE; the browser does not participate in application.

- **Pros**: No browser-side parse/apply logic at all. Containment is trivially server-enforced.
- **Cons**: Applies files on disk without the user seeing the diff in the editor first
  (non-reviewable). The browser buffer becomes stale until the file is reloaded (no undo
  in-editor, violating AC4). Crosses into the territory of the existing `patchApplyRoutes.ts`
  (#1204) route, which is a separate, gated, default-off flow for test-generation. Mixing the
  agent action path with a file-write path creates a new code-path through `applyPatch` in
  keiko-tools that bypasses the test-generation review gate.
- **Why rejected**: Violates AC4 (no Monaco undo path exists for a server-side file write).
  Bypasses user review. Conflates the agent action loop with the #1204 governed file-write
  route.

### Alternative 3: Defer applyPatch entirely — return OUT_OF_SCOPE for all patch actions

Mark `applyPatch` as permanently out of scope for the agent action path; route all patch
application through the #1204 `patchApplyRoutes.ts` flow.

- **Pros**: Zero new complexity in the agent action path. No new parser, no review UI, no browser
  state additions.
- **Cons**: Fails to close Issue #1394. The `applyPatch` action type exists in the schema and is
  accepted by `isEditorAgentAction`; returning `OUT_OF_SCOPE` always is a placeholder, not an
  implementation. Agents would need a separate integration with the #1204 route.
- **Why rejected**: Does not satisfy the issue scope. Issue #1394 explicitly lists `applyPatch`
  as within scope and `applyTextEdits/applyPatch` as both deliverables.

## Related

- ADR-0019: Modular package architecture — leaf-rule constraints on `editor-agent.ts`
- ADR-0042: Keiko Editor package and boundaries — `@oscharko-dev/keiko-editor` boundary rules
- ADR-0028: Workspace commands undo — compile-time prohibition on undo of patch/evidence records
- Issue #1296: Agent-native editor foundation (built the scaffolding this issue closes)
- Issue #1204: Test-generation patch preview and apply route (`patchApplyRoutes.ts`, `KeikoDiffEditor` precedent)
- `packages/keiko-tools/src/patch.ts`: `validatePatch`, containment, binary detection
- `packages/keiko-workspace/src/paths.ts`: `resolveWithinWorkspace`

## Date

2026-06-25
