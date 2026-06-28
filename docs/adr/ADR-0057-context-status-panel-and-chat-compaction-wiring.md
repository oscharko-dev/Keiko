# ADR-0057: Context-engineering UI summary panel and chat-compaction evidence wiring

## Status

Proposed

## Context

PR6 closes the context-engineering milestone (ADR-0052 through ADR-0056). Five decisions remain
open after PR5:

1. **Wire summary**: `GroundedAnswerContextPackSummary` (bff-wire.ts:603) does not yet carry the
   aggregate budget projection (total estimated tokens, budget pressure, per-lane counts) that
   ADR-0052 D6 sketched as `contextSummary?`. The builder `buildGroundedAnswerContextPackSummary`
   has `pack.diagnostics?.contextBudget` (the `ContextBudget` plan) and, via the same server-side
   derivation used by the PR5 evidence path, the `ContextAssemblyDiagnostics` (actual usage).
   Neither is projected into the browser-visible summary today.

2. **UI panel**: No browser-visible panel surfaces context-budget aggregate state. The ADR-0022
   privacy contract prohibits raw file paths, scores, and per-file signals in the browser. A new
   component must show only aggregate counts and token totals.

3. **Chat-compaction evidence wiring**: `buildGatewayMessages` (chat-handlers.ts:924) calls
   `conversationForGatewayWithCompaction` and destructures only `{ messages }`, discarding the
   `compaction?: ContextCompactionRecord` field. `persistCompactionEvidence` (keiko-evidence) is
   contract-ready and unit-tested since PR5 but has no live caller on the chat path.

4. **Path-free guarantee mechanism**: The structural mechanism that ensures neither the wire
   summary nor the UI panel can carry raw paths, scope IDs, or excerpt content must be documented.

5. **Browser verification plan**: The coordinator must enumerate exactly how to verify the panel
   in the running product after an implementor delivers it.

### Seam inventory (verified by reading)

- `bff-wire.ts:603` — `GroundedAnswerContextPackSummary` (path-free counts-only struct).
- `bff-wire.ts:683` — `buildGroundedAnswerContextPackSummary(pack, citationCount, elapsedMs)`.
- `context-engineering.ts:97` — `ContextBudget { profile, lanes }` (the plan).
- `context-engineering.ts:124` — `ContextAssemblyDiagnostics { totalEstimatedTokens, budgetPressure, lanes: ContextLaneDiagnostics[] }` (actual usage per lane).
- `connected-context.ts:304–308` — `ContextPackDiagnostics.contextBudget?: ContextBudget` (PR4 attach point).
- `grounded-context-diagnostics.ts:91` — `deriveGroundedContextAssembly(pack, profile)` — the single shared derivation used by PR5 evidence.
- `GroundedAnswer.tsx:68` — `MetricRow` reusable component.
- `GroundedAnswer.tsx:87` — `RankingRationale` — the `<details>` collapsed-by-default pattern, already shipping.
- `ChatWindow.tsx:1641` — `.chatw-log` div containing `GroundedAnswerPanel` at line 1669.
- `lib/format.ts:94` — `formatTokens` — already exported.
- `lib/types.ts` — the only legal import barrel for wire types into keiko-ui (ADR-0019 re-export gate).
- `chat-handlers.ts:924` — `buildGatewayMessages` discards `compaction` from `conversationForGatewayWithCompaction`.
- `chat-stream-handlers.ts:163` — streaming path calls `buildGatewayMessages` identically.
- `compaction-evidence.ts:322` — `persistCompactionEvidence(input, ctx)` accepts `runId`, `records`, `startedAt`, `finishedAt`, `chatIdHash?`.
- `runid.ts:9,21` — `MAX_RUN_ID_LENGTH = 256`, charset `[A-Za-z0-9._-]`, no leading dot.
- `types.ts:200` (keiko-evidence) — `DEFAULT_RETENTION = { maxRuns: 50 }`.

## Decision

We will deliver five coordinated changes in PR6, each with no new package-graph edge and no
breaking change to existing callers.

### D1 — Extend GroundedAnswerContextPackSummary with an additive path-free contextSummary field

We will add to `bff-wire.ts`:

```ts
export interface GroundedAnswerContextSummary {
  readonly totalEstimatedTokens: number;
  readonly budgetPressure: ContextBudgetPressure;
  // Per-lane counts only; ContextLaneId is a string literal union of eight fixed lane names,
  // never a file path, scope identifier, or workspace root.
  readonly laneCounts: Readonly<Record<ContextLaneId, number>>;
  // True when the history-compaction splice fired for this turn (PR4 D3 slow path).
  readonly compactionActive: boolean;
}
```

We will extend `GroundedAnswerContextPackSummary` additively:

```ts
readonly contextSummary?: GroundedAnswerContextSummary | undefined;
```

We will extend `buildGroundedAnswerContextPackSummary` to accept a fourth optional parameter:

```ts
buildGroundedAnswerContextPackSummary(
  pack: ConnectedContextPack,
  citationCount: number,
  elapsedMs: number,
  assemblyDiagnostics?: ContextAssemblyDiagnostics,
): GroundedAnswerContextPackSummary
```

When `assemblyDiagnostics` is present it derives `contextSummary` from the assembly's
`totalEstimatedTokens`, `budgetPressure`, and a `laneCounts` map built by counting
`assemblyDiagnostics.lanes` (one entry per populated lane, value = `lane.includedItems`). When
absent the field is simply omitted (spread nothing). Existing callers pass three arguments and
receive an identical result — backward-compatible by construction.

The grounded-QA call site in `keiko-server` already computes `deriveGroundedContextAssembly` for
the evidence path (PR5 W3). It will pass the same result as the fourth argument.

**Why this shape**: `ContextLaneId` is a finite string literal union locked in
`context-engineering.ts:15–23`; it carries no path information. `totalEstimatedTokens` and
`budgetPressure` are a number and an enum. `includedItems` is a count. The type is structurally
path-free by inspection — there is no field that can hold a `string` that is a file path.

**Why a dedicated grounded context summary**: the grounded context-assembly path has access to
`ContextAssemblyDiagnostics`; composer history controls do not. Mixing those signals would couple
the grounded path's assembly pass to composer affordances. PR6 keeps the context status panel
grounded-context-specific.

### D2 — A new ContextStatusPanel component (separate file, collapsed-by-default disclosure)

We will create `packages/keiko-ui/src/app/components/desktop/ContextStatusPanel.tsx` as a
separate file (not inlined into GroundedAnswer.tsx or ChatWindow.tsx) with a single named export
`ContextStatusPanel`.

**Disclosure pattern**: We will use the native `<details>/<summary>` pattern, matching the
existing `RankingRationale` component at `GroundedAnswer.tsx:99`. Reasons:

- Native HTML: collapsed by default, keyboard-accessible, no `useState`, cyclomatic complexity
  remains at 1 per rendering function.
- Already shipping: `RankingRationale` demonstrates the pattern in the same file the panel's
  sibling components live in. Two usages of `<details>` in the same disclosure area creates
  a consistent interaction model.
- The `MemoryPanel` aria-expanded + `useState` pattern (ChatWindow.tsx:1386) adds a controlled
  toggle button and disclosure `id` — justified there because the disclosure is detached from its
  trigger in the DOM. For an inline collapsed panel that sits inside the `.chatw-grounded` zone,
  native `<details>` is the simpler, lower-complexity choice.

The panel renders: effective budget (tokens), total estimated tokens (with pressure label), and
per-lane source counts from `contextSummary.laneCounts`, plus a "Compaction active" / "No
compaction" indicator from `contextSummary.compactionActive`. It reuses `MetricRow`
(GroundedAnswer.tsx:68) for all rows and `formatTokens` (lib/format.ts:94) for token numbers.

The panel is mounted inside `GroundedAnswerPanel` (ChatWindow.tsx:1147–1176), which already
conditionally renders when a grounded answer is present. `ContextStatusPanel` receives only the
optional `contextSummary?: GroundedAnswerContextSummary` prop; it renders `null` when the field
is absent (legacy packs, non-profiled turns).

**Stylesheet**: New `.ctx-*` classes in `globals.css` (the single stylesheet, ADR-0049). The
classes mirror the existing `.grounded-context-pack*` token usage (no new raw values; all sizes
and colours from existing design tokens). They are pinned by a new `Issue #PR6` block in
`globals.css.test.ts`.

**Tests required**:

- `ContextStatusPanel.test.tsx` — renders null when `contextSummary` is undefined; renders
  aggregate budget + lane counts when present; `<details>` is closed by default; no path strings
  in rendered output (`not.toContain("/")` and `not.toContain("\\")` on all text content);
  formatTokens called for token numbers.
- `ContextStatusPanel.a11y.test.tsx` — jest-axe clean on the expanded and collapsed states.
- `globals.css.test.ts` `.ctx-*` pin block added.

The `not.toContain` path-leak test is the structural path-free gate: because all string values
come from the `GroundedAnswerContextSummary` type (numbers, enum, Record of lane-name → count,
boolean), any implementation bug that accidentally renders a path would cause the test to fail
without requiring knowledge of specific path patterns.

### D3 — Wire the discarded chat-compaction record to persistCompactionEvidence

**The problem**: `buildGatewayMessages` (chat-handlers.ts:924) calls
`conversationForGatewayWithCompaction` and returns only `messages`. The `compaction?:
ContextCompactionRecord` from `ConversationCompactionOutcome` is silently dropped. Both call sites
— `persistModelChatTurn` (chat-handlers.ts:941) and `streamAndPersist` (chat-stream-handlers.ts:148)
— invoke `buildGatewayMessages` and have `request.chatId` and timing information available.

**Decision**: We will split `buildGatewayMessages` into two functions:

1. `deriveCompactionOutcome(deps, request): ConversationCompactionOutcome` — calls
   `conversationForGatewayWithCompaction` and returns the full outcome including `compaction?`.
2. `buildGatewayMessages(deps, request, memoryText): GatewayConversationMessage[]` — calls
   `deriveCompactionOutcome`, applies document context, and returns messages (signature unchanged
   for all existing call sites).

Both `persistModelChatTurn` and `streamAndPersist` will be updated to call
`deriveCompactionOutcome` before `buildGatewayMessages`, capturing `compaction?`. When
`compaction` is present they call `persistCompactionEvidence` with the record AFTER the turn
completes (post-response, best-effort: a persistence failure does not fail the send request).

**runId scheme**: The runId must pass `assertValidRunId` (charset `[A-Za-z0-9._-]`, no leading
dot, length ≤ 256). We will use:

```
chat-{sha256Hex(request.chatId).slice(0, 16)}-t{messageCount}
```

where `messageCount = deps.store.listMessages(request.chatId).length` at the moment the user
message is created (before the assistant message is stored). `sha256Hex` produces hex-only
characters; the prefix `chat-` and suffix `-t<number>` use only allowed characters. Maximum
length is `5 + 16 + 2 + 20 = 43` characters, well within the 256 cap. This scheme is
deterministic for the same chat turn and collision-resistant (distinct chats that happen to have
the same turn count have distinct sha256 prefixes).

The `chatIdHash` field in `CompactionEvidenceInput` (compaction-evidence.ts:48) is populated with
`sha256Hex(request.chatId)` — the raw chatId never enters the evidence manifest.

**Retention**: `DEFAULT_RETENTION` (`maxRuns: 50`). Chat-compaction evidence is of the same
sensitivity class as grounded-context evidence (already using `DEFAULT_RETENTION`). No
dedicated bounded profile is needed.

**Timing**: `startedAt` is captured from `Date.now()` before the model call; `finishedAt` is
captured after. The helper is passed through an existing timing boundary — no new timer.

**Why not a session-end approach**: The compaction record is produced and available immediately
after `conversationForGatewayWithCompaction`. Deferring to session end would require holding
records in memory across an indefinite number of turns. Per-turn persistence matches the existing
pattern for connected-context evidence and keeps the evidence store's runId namespace
collision-free.

**Why not modify buildGatewayMessages' return type**: The function is exported and both call sites
use it. Changing the return type would require simultaneous updates to `chat-stream-handlers.ts`
and `chat-handlers.ts`, and any future callers. Extracting `deriveCompactionOutcome` as a new
internal helper is strictly additive: `buildGatewayMessages` delegates to it and the existing
signature is unchanged. The streaming and buffered callers can independently opt into capturing
the `compaction` record.

### D4 — Path-free guarantee mechanism

The guarantee is structural (type-level), not runtime-validated, at the wire boundary, and
supplemented by a test gate:

1. **Type boundary**: `GroundedAnswerContextSummary` contains only `number`, `ContextBudgetPressure`
   (string literal union), `Readonly<Record<ContextLaneId, number>>` (ContextLaneId is a fixed
   8-member string literal union, not user input), and `boolean`. There is no field of type `string`
   that could carry a path. TypeScript's strict mode enforces this at compile time.

2. **Builder isolation**: `buildGroundedAnswerContextPackSummary` derives the `contextSummary`
   exclusively from `ContextAssemblyDiagnostics`, which contains only the types above plus
   `ContextProfile` (numbers and a string `tokenEstimatorId` — not a path). The builder never
   reads `ConnectedContextPack.scope.relativePaths`, `scopeId`, or any excerpt field.

3. **Test gate**: The `ContextStatusPanel.test.tsx` `not.toContain("/")` assertion catches any
   implementation that accidentally renders a path. This is the runtime-observable complement to
   the type-level guarantee.

4. **Unaffected surfaces**: `buildEvidenceReport`, the grounded-answer citation list, and the
   existing `GroundedAnswerContextPackSummary` fields are untouched. The `contextSummary` field is
   optional and absent on all existing packs — zero diff on the legacy surface.

### D5 — Browser verification plan

The coordinator verifies the following in the running product after W2 (UI) is delivered.
Prerequisite: a workspace is open and at least one grounded question has been answered.

1. **Panel absent by default (non-grounded chat)**: Send a plain chat message without a connected
   scope. Verify no `.ctx-status` element is present in the page (DevTools element inspector).

2. **Panel rendered and collapsed**: Answer a grounded question. Scroll to the bottom of the chat
   log. Verify a `<details>` element with summary text "Context" (or the implementor's chosen
   label) is present and `open` attribute is absent.

3. **Panel expands correctly**: Click the `<details>` summary. Verify the panel opens and shows:
   - "Effective budget" row with a token count in the expected format (e.g. "116,000 tok").
   - "Estimated" row with total tokens and a pressure label ("low", "moderate", "high", or
     "exceeded").
   - At least one lane row (e.g. "repo-evidence") with a count > 0.
   - "Compaction" row showing either "active" or "inactive".

4. **No raw paths visible**: With DevTools console open, run:
   `document.querySelector('.ctx-status')?.textContent` and verify the string contains no `/`
   followed by a word character (regex `/\/\w/`). This catches any accidental path leak.

5. **No raw numbers that could be scores**: Verify no floating-point numbers with decimal places
   appear in the panel text (all displayed values should be integers or formatted strings).

6. **Accessibility**: Open DevTools > Accessibility tree. Verify the `<details>` element has an
   accessible name. Verify no critical/serious axe violations when the panel is expanded (run
   `axe(document.querySelector('.chatw-grounded'))` in console with axe-core loaded).

7. **Dark and Light themes**: Toggle themes if Light Mode is accessible in the running product.
   Verify the panel is legible in both themes (text contrast not obviously broken).

8. **Compaction indicator live**: For a session with > 24 messages (the `MAX_CONTEXT_MESSAGES`
   threshold), send another grounded message. Verify the compaction row shows "active".

## Consequences

### Positive

- The coordinator's in-app verification provides the milestone-closing human-reviewed acceptance
  that the PR5 evidence pipeline alone cannot supply (evidence is local files, not browser UI).
- `persistCompactionEvidence` gains its first live caller, completing the PR5 contract-ready
  design.
- The `GroundedAnswerContextSummary` type is structurally path-free at compile time, so future
  implementors cannot accidentally add a path field without a type error.
- The `<details>/<summary>` pattern is the lowest-complexity disclosure option and matches the
  existing `RankingRationale` component, keeping the interaction model consistent.
- `deriveCompactionOutcome` as a new private helper decouples the compaction record from the
  `buildGatewayMessages` return type, leaving all existing callers unchanged.

### Negative

- `buildGroundedAnswerContextPackSummary` gains a fourth optional parameter. Callers that do not
  supply it receive an unchanged result, but the function signature grows. If the function is
  called in more than two places the optional parameter pattern may accumulate.
- The `not.toContain("/")` path-free test gate is heuristic: a path in a URL-encoded form or
  a Windows path using backslashes would not be caught by the forward-slash check. The type-level
  guarantee is the authoritative mechanism; the test is defense in depth.
- Per-turn compaction evidence persistence adds one synchronous `store.put` call per compacted
  turn on the chat path. On the fast path (no compaction, the common case) this is a no-op.

### Neutral

- Composer history controls are a separate concern from the grounded assembly panel; mixing them
  in PR6 would introduce a cross-path dependency without a measurable user benefit.
- `lib/types.ts` (the ADR-0019 re-export barrel) must be extended to export
  `GroundedAnswerContextSummary` and `ContextLaneId` so `ContextStatusPanel.tsx` can import them
  without violating the ADR-0019 dependency-direction rule (keiko-ui imports only via the barrel,
  never directly from `@oscharko-dev/keiko-contracts`).
- The `ContextStatusPanel` is absent (renders null) when `contextSummary` is undefined. This means
  the panel does not appear on non-grounded chats and on grounded chats where the context profile
  is absent or the pack carries no `contextBudget` diagnostics (legacy path, pre-PR4). This is
  correct: the panel is grounded-context-specific.
- `globals.css` gains new `.ctx-*` classes. They must use existing design tokens (no new raw
  values) to satisfy ADR-0050 gate 4.

## What PR6 does NOT do

- Does not change composer history controls.
- Does not add a new `EvidenceTaskType` (consistent with PR5 D1).
- Does not expose per-file paths, scores, or excerpt content in the browser (structural type
  guarantee).
- Does not change the grounded-QA prompt or any message sent to the model.
- Does not add a new package-graph edge (all new code is within existing packages).
- Does not add a new npm dependency.
- Does not touch `buildEvidenceReport` or any browser-facing evidence surface.
- Does not wire `ShapedBrowserObservation` (no live producer; remains forward-defined per PR3).
- Does not persist compaction records on the fast path (compaction is a no-op when
  `contextProfile === undefined` OR `filteredMessages.length <= MAX_CONTEXT_MESSAGES`).

## Measurable gates

| Gate | Mechanism | Pass criterion |
| --- | --- | --- |
| Wire backward-compat | `buildGroundedAnswerContextPackSummary` called with 3 args | Existing tests unchanged; TypeScript compiles |
| Path-free (type-level) | `GroundedAnswerContextSummary` has no `string` field | `tsc --noEmit` passes with strict mode |
| Path-free (test-level) | `ContextStatusPanel.test.tsx` `not.toContain("/")` | Test green |
| a11y | `ContextStatusPanel.a11y.test.tsx` jest-axe | Zero serious/critical violations |
| Chat evidence persist | `compaction-evidence.test.ts` new test: runId scheme assertValidRunId-safe | Test green |
| Chat evidence roundtrip | `persistCompactionEvidence` called with chat-turn input returns a manifest | Test green (unit) |
| Stylesheet pin | `globals.css.test.ts` `.ctx-*` block | Test green |
| Browser-verified | Coordinator visual inspection against D5 checklist | Human review noted in PR |
| Full suite | `npm test` | 0 regressions |

## Wave breakdown

### W1 — Contracts: GroundedAnswerContextSummary + builder extension + tests

**Package**: `keiko-contracts`.
**Files**: `bff-wire.ts`, `context-engineering-validation.ts` (extend if needed for new type
validation), `bff-wire.test.ts` (new tests for `buildGroundedAnswerContextPackSummary` with
assembly diagnostics; backward-compat with 3-arg form; structural path-free inspection of every
field).
**Boundary**: keiko-contracts is a strict leaf; this wave adds only types and a pure builder.
No IO, no package-graph change.

### W2 — UI: ContextStatusPanel + globals.css + a11y + path-free tests

**Package**: `keiko-ui`.
**Files**: `ContextStatusPanel.tsx` (new, ≤ 50 LOC per function), `lib/types.ts` (barrel
extensions: `GroundedAnswerContextSummary`, `ContextLaneId`, `ContextBudgetPressure`),
`ContextStatusPanel.test.tsx`, `ContextStatusPanel.a11y.test.tsx`, `app/globals.css` (new
`.ctx-*` classes), `globals.css.test.ts` (new pin block), `ChatWindow.tsx` (pass
`contextSummary` to `GroundedAnswerPanel` → `ContextStatusPanel` mount inside
`.chatw-grounded`).
**Boundary**: No new package-graph edge. `ContextStatusPanel` imports only from `@/lib/types`
and `@/lib/format`, both in-package. MetricRow is imported from `GroundedAnswer.tsx` or
extracted to a shared local file if the implementor prefers — no external edge either way.

### W3 — Server: chat-compaction evidence wiring + tests

**Package**: `keiko-server`.
**Files**: `chat-handlers.ts` (new `deriveCompactionOutcome` helper; update
`persistModelChatTurn` to capture compaction and call `persistCompactionEvidence` best-effort),
`chat-stream-handlers.ts` (update `streamAndPersist` identically), `chat-handlers.test.ts` (new
test: when slow path fires, compaction record is passed to evidence; fast path no-op; runId
passes `assertValidRunId`).
**Boundary**: `persistCompactionEvidence` is already imported by the grounded-QA path. No new
keiko-server → keiko-evidence edge is introduced. The chatIdHash is `sha256Hex(request.chatId)`;
no raw chatId leaves the server layer.

### W4 — Coordinator: in-app browser verification + gate tighten + milestone close

**Not a code wave.** The coordinator starts the product with the PR6 branch, performs the D5
verification checklist, and records the result in the PR body. If any check fails the implementor
is re-engaged. On pass, the PR description is updated with the human-review note and the
milestone is declared closed.

## Alternatives Considered

### Alternative 1: Extend buildGatewayMessages to return { messages, compaction? }

- **Pros**: Single call site change; callers receive compaction alongside messages naturally.
- **Cons**: Changes the exported return type of `buildGatewayMessages`, requiring simultaneous
  updates to all callers (buffered + streaming) and any future callers; the function's name
  suggests it returns messages only. The PR comment at chat-handlers.ts:920 explicitly documents
  it as a "message assembly" function.
- **Why rejected**: Extracting `deriveCompactionOutcome` as a private helper achieves the same
  result without changing the exported signature, preserving the single responsibility of
  `buildGatewayMessages`.

### Alternative 2: Persist compaction at session end (lazy batch)

- **Pros**: Single write per session; avoids per-turn overhead.
- **Cons**: Requires holding in-memory compaction records across an indefinite number of turns
  (memory leak risk); complicates session lifecycle (when is "session end"? The desktop chat has
  no explicit session termination event); evidence may be lost on crash or process exit.
- **Why rejected**: Per-turn persistence matches the grounded-context evidence pattern and the
  compaction record is small (a few hundred bytes per turn). The fast-path no-op eliminates
  overhead when compaction does not fire.

### Alternative 3: MemoryPanel aria-expanded pattern for the disclosure

- **Pros**: Programmatic control; easy to expand from test code; consistent with the memory
  panel in the same ChatWindow.
- **Cons**: Adds a `useState`, an `id`, an `aria-controls`, and increases cyclomatic complexity
  in the new component. The MemoryPanel pattern is justified there because the toggle button is
  spatially detached from the disclosed content in the DOM.
- **Why rejected**: The `<details>/<summary>` pattern (already used by `RankingRationale` in
  `GroundedAnswer.tsx:99`) is the lower-complexity choice when the toggle and the content are
  contiguous. Consistency with RankingRationale inside the `.chatw-grounded` zone outweighs
  consistency with MemoryPanel outside it.

### Alternative 4: Inline ContextStatusPanel into GroundedAnswer.tsx

- **Pros**: Fewer files; MetricRow is already there.
- **Cons**: `GroundedAnswer.tsx` would grow beyond the 400-LOC file budget. The component has
  its own test file requirement; a separate file allows independent test coverage without
  re-testing GroundedAnswer.
- **Why rejected**: CLAUDE.md hard rule: files ≤ 400 LOC. Adding the panel and its styles inline
  would push GroundedAnswer.tsx over that limit and violate the single-reason-to-change
  separation of concerns principle.

### Alternative 5: Derive contextSummary from ContextBudget (plan) rather than ContextAssemblyDiagnostics (usage)

- **Pros**: `ContextBudget` is already attached to `pack.diagnostics.contextBudget` and available
  to `buildGroundedAnswerContextPackSummary` without a new parameter; simpler builder signature.
- **Cons**: `ContextBudget` carries the PLAN (per-lane `maxTokens` and `minReservedTokens`), not
  actual usage. `totalEstimatedTokens` and per-lane actual counts come from
  `ContextAssemblyDiagnostics.lanes[].estimatedTokens`. Displaying plan values as if they were
  usage would be misleading.
- **Why rejected**: Showing the user "116,000 tokens budgeted" rather than "34,000 tokens
  estimated" is a different, less informative signal. The assembly diagnostics are already
  computed on the same code path (PR5 derives them for evidence). Passing them as an optional
  fourth parameter costs one additional argument at one call site.

## Related

- ADR-0052: Deterministic context-engineering layer (contextSummary attach point sketched)
- ADR-0053: Compaction records, invalidation, rehydration
- ADR-0054: Tool-observation shaping
- ADR-0055: Orchestrator and harness wiring (conversation-compaction.ts, conversationForGatewayWithCompaction)
- ADR-0056: Regulated evidence context assembly and compaction (persistCompactionEvidence contract-ready)
- ADR-0022: Connected context privacy (path-free browser contract)
- ADR-0019: Modular package architecture (lib/types.ts barrel rule)
- ADR-0049: Design System fidelity gates (globals.css single stylesheet, no raw values)
- ADR-0050: Component state and governance contract (no new [data-theme="light"] one-offs)

## Date

2026-06-24
