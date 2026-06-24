# ADR-0055: Context-engineering integration — orchestrator and harness wiring

## Status

Proposed

## Version

0.2.0

## Context

ADR-0052 (PR1), ADR-0053 (PR2), and ADR-0054 (PR3) are fully implemented and verified on
`feat/context-engineering-foundation`. All three PRs are purely additive: they define contracts,
build helpers, and tighten CI gates without touching any live prompt-assembly path. PR4 is the
first behavior-affecting integration wave. It threads the existing contracts through the two live
context paths — the grounded repo-QA orchestrator and the agentic harness/chat path — while
providing a non-negotiable non-regression guarantee for all existing behavior.

### The two live context paths (confirmed by direct read)

**Path 1 — Grounded repo-QA.**
`keiko-server/src/grounded-orchestrator.ts` → `grounded-qa.ts` → `GroundedAnswerer.answer()` →
model. The pack assembly entry point is `assembleGroundedPack` (~L2055), which delegates to
`assemblePackFromReads` (~L1931). The final prompt is built by `buildGroundedGatewayMessages`
(`grounded-qa.ts:L630–635`) via `promptBudgetedMessages` (`grounded-qa.ts:L476–512`). The wire
output is controlled entirely by `promptBudgetedMessages`, which uses `pack.budget.modelInputTokensMax`
and `APPROX_BYTES_PER_TOKEN = 4` (`grounded-qa.ts:L430`). This function is the AC5 invariant
boundary: nothing above it in the call stack — including diagnostics — can affect its output.

The multi-source path (`grounded-qa-multi-source.ts`) imports and reuses
`buildGroundedGatewayMessages` from `grounded-qa.ts` directly (`multi-source.ts:L73`). The hybrid
path (`grounded-qa-hybrid.ts:L4–8`) composes both. Both module headers carry explicit "wire output
stays byte-identical" comments.

**Path 2 — Agentic harness and chat.**
`keiko-harness/src/loop.ts` → `executor.ts:handleToolCall` → `planner.ts:handleContextSelection`.
Context size is measured by `contextBytes()` (`keiko-harness/src/context.ts:L64`) as
`encoder.encode(JSON.stringify(messages)).length`. The hard byte limit is
`HarnessLimits.maxContextBytes = 512 KB`. Desktop chat history is assembled by
`conversationForGateway` (`chat-handlers.ts:L294–308`), which applies a hard
`slice(-MAX_CONTEXT_MESSAGES)` where `MAX_CONTEXT_MESSAGES = 24` (`chat-handlers.ts:L86`).
`buildGatewayMessages` (`chat-handlers.ts:L912–919`) is shared by both the buffered
(`persistModelChatTurn`) and streaming (`handleSendDesktopChatStream`) send paths.

### Available surface from PR1–PR3

- `allocateContext`, `DEFAULT_CONTEXT_BUDGET` — `keiko-workflows/src/context-budget/index.ts`
- `buildCompactionRecords`, `rehydrateProvenanceRef`, `rehydrateHandle` — same module
- `shapeCommandObservation`, `shapeTestObservation`, `shapeSearchObservation` —
  `keiko-workflows/src/observations/index.ts`
- `DEFAULT_CONTEXT_PROFILE`, `estimateTokens`, `ContextPackDiagnostics.contextBudget?`,
  `ContextAssemblyDiagnostics`, `ToolCallResult.shapedObservation?` — `keiko-contracts`
- `UiHandlerDeps` (`deps.ts:L100`) — the dependency-injection point for keiko-server wiring

### Non-negotiable invariants (the whole PR is judged on these)

1. **AC5**: the single-source grounded wire output (prompt bytes + wire response) is byte-identical
   to today for all existing test vectors. Multi-source and hybrid paths likewise.
2. **Short-session chat byte-identity**: sessions at or below `MAX_CONTEXT_MESSAGES = 24` messages,
   or when no `ContextProfile` is present, produce a byte-identical `GatewayConversationMessage[]`
   to today.
3. **First lexical ring preserved**: `ContextPackDiagnostics.rankedCandidates` remains populated
   from the lexical ring (`grounded-orchestrator.ts:L448`) and available to existing callers.
4. **Model-agnostic**: no provider tokenizer. `estimateTokens` only.
5. **No DEFAULT_EXPLORATION_BUDGET.modelInputTokensMax change** (breaking; thread via
   `OrchestratorInput.budget` as today).
6. **No new package-graph edges**: `keiko-server` already depends on `keiko-workflows` and
   `keiko-contracts`. The new wiring uses only these existing edges.

### LOC constraints (confirmed)

`grounded-orchestrator.ts` is 2,178 LOC. `chat-handlers.ts` is 1,086 LOC. `deps.ts` is 779 LOC.
`grounded-qa.ts` is 1,191 LOC. All are at or near the 400-LOC-per-file cap for new modules
(CLAUDE.md); new logic must live in NEW sibling modules that the existing files delegate to, not
inline additions to these files.

## Decision

We will deliver PR4 as four waves, each leaving the codebase in a green, fully-tested state. PR4
introduces the FIRST live behavior changes: a diagnostics observer on the grounded pack
(non-mutating, observer-only), a gated history-compaction splice in chat, additive shaped-observation
attachment in the harness, and `ContextProfile` provisioning in `UiHandlerDeps`. Every change is
guarded by the single-predicate unchanged-guarantee described in D6.

### D1 — DIAGNOSTICS-FIRST threading: observer over the grounded pack (PR4-W1)

We will introduce a new pure sibling module
`keiko-server/src/grounded-context-diagnostics.ts` (≤ 400 LOC) that accepts a fully assembled
`ConnectedContextPack` and a `ContextProfile` and produces a `ContextAssemblyDiagnostics`.

The observer runs in `assembleGroundedPack` (`grounded-orchestrator.ts:L2055`), after
`assemblePackFromReads` returns the fully built pack and BEFORE the pack is returned to
`runGroundedExploration` or `retrieveConnectedContextPack`. The diagnostics are attached via
conditional-spread to the EXISTING `pack.diagnostics?.contextBudget?` attach point defined in
`ContextPackDiagnostics` (`connected-context.ts:L304–308`, `contextBudget?: ContextBudget | undefined`).

The observer maps the three present lanes in the grounded path (`system-contract`,
`user-task`, `repo-evidence`) onto the eight-lane taxonomy. It calls `estimateTokens` on the
pack's constituent text segments to populate per-lane `ContextLaneDiagnostics`, then produces a
`ContextAssemblyDiagnostics` attached to `pack.diagnostics.contextBudget`.

**Crucial constraint:** the observer DOES NOT change which evidence is selected, does NOT mutate
any text, does NOT alter the budget struct (`pack.budget`), and does NOT affect `pack.stableId`
(the stable id hashes only `scope`, `query`, and `atom ids` — never `pack.diagnostics`). The pack
returned to `buildGroundedGatewayMessages` is identical in all content-bearing fields; only the
optional `diagnostics.contextBudget?` field is newly populated. `buildGroundedGatewayMessages`
(`grounded-qa.ts:L630`) does not read `pack.diagnostics`; AC5 is structurally guaranteed.

The observer is conditional on `deps.contextProfile !== undefined`. When no profile is threaded
through `OrchestratorDeps` (existing tests, legacy callers), the observer is not called and the
pack is returned as today. The activate-when-absent-profile predicate is the
unchanged-guarantee mechanism (D6).

The profile enters `OrchestratorDeps` as an optional field:

```ts
// keiko-server/src/grounded-orchestrator.ts — additive field on OrchestratorDeps
export interface OrchestratorDeps {
  // ... all existing fields unchanged ...
  // Optional context profile. When absent (legacy callers), the diagnostics observer is
  // not invoked and the assembled pack is byte-identical to today. When present, the
  // observer attaches ContextAssemblyDiagnostics to pack.diagnostics.contextBudget?
  // (additive, not read by any prompt-building function).
  readonly contextProfile?: ContextProfile | undefined;
}
```

The multi-source path (`grounded-qa-multi-source.ts`) calls `retrieveConnectedContextPack` per
source and passes its own `OrchestratorDeps` derived from `ctx.deps`. The optional
`contextProfile?` field threads naturally through that derivation. The hybrid path
(`grounded-qa-hybrid.ts`) composes both and is covered by the same optional threading.

### D2 — AC5 strategy: why the single-source (and multi/hybrid) wire bytes are unchanged

The grounded wire output is determined entirely by `promptBudgetedMessages`
(`grounded-qa.ts:L476`). That function reads `pack.budget.modelInputTokensMax` and the
excerpt text from `pack.files[*].excerpts[*].content`. Neither of those fields is touched by the
diagnostics observer or by any other PR4 addition. Specifically:

1. `pack.budget` — `plan.budget` (an `ExplorationBudget`) is built before the observer runs and
   is not modified by the observer.
2. `pack.files[*].excerpts[*].content` — excerpt text is assembled by `assemblePackFromReads`
   and is not touched post-assembly.
3. `pack.diagnostics` — read ONLY by the evidence persistence layer and the BFF wire summary
   builder (`buildGroundedAnswerContextPackSummary`, `bff-wire.ts:L683`), neither of which feeds
   into `promptBudgetedMessages`.
4. `pack.stableId` — computed from `scope + query + atom ids` inside `assembleContextPack`
   (keiko-workspace); the diagnostics attach after this computation, outside the workspace layer.

**Mechanical AC5 test (W1 gate):** a test fixture that calls `runGroundedExploration` with a
`ContextProfile` present and with no profile present must produce byte-identical
`buildGroundedGatewayMessages(question, pack, redactor)` output. This is pinned as a required
gate (`ac5ByteIdentical: true`) in `scripts/check-context-quality.budget.json`.

For multi-source: `grounded-qa-multi-source.ts` assembles each scope's pack via
`retrieveConnectedContextPack`, then passes the packs directly to a model call that uses
`promptBudgetedMessages` from `grounded-qa.ts`. The diagnostics attach to each individual pack's
`diagnostics.contextBudget?` field; the multi-source answer call reads only `pack.files` and
`pack.budget`. Byte-identical.

For hybrid: `grounded-qa-hybrid.ts` similarly assembles packs per connector, merges them, and
builds the answer prompt. The diagnostics are additive fields on each pack. The hybrid answer
builder reads only the merged evidence content. Byte-identical.

### D3 — HISTORY-COMPACTION SPLICE: the one genuine behavioral change (PR4-W2)

We will introduce a new pure sibling module
`keiko-server/src/conversation-compaction.ts` (≤ 400 LOC). It wraps `conversationForGateway`
(`chat-handlers.ts:L294`) with a thin, predicate-guarded shim that activates ONLY when both
conditions are true:

```
(a) deps.contextProfile !== undefined         // profile must be explicitly provisioned
(b) rawHistory.length > MAX_CONTEXT_MESSAGES  // splice is only needed above the existing window
```

When either condition is false, the shim returns the output of the EXISTING `conversationForGateway`
call verbatim, without modification. This is the exact mechanism that guarantees byte-identity
for short sessions and for all existing tests.

When both conditions are true (a long session with a profile), the shim:

1. Runs `conversationForGateway` on the last `MAX_CONTEXT_MESSAGES` messages (the existing slice)
   to obtain the unchanged recent-turn window.
2. Calls `buildCompactionRecords` (`keiko-workflows/src/context-budget/compaction.ts`) on the
   messages that were sliced off (the `rawHistory.slice(0, -MAX_CONTEXT_MESSAGES)` prefix).
3. Produces a compact provenance-backed summary segment: a single `user`-role synthetic message
   (a labeled, redacted, byte-bounded digest of the dropped turns). **Decision refined during PR4-W2:**
   the segment is a `user` turn, NOT a second `system` turn — heterogeneous/open-weight customer models
   may merge or mishandle multiple system messages, so a labeled `user`-role context turn is the
   model-agnostic-safe choice. It is placed immediately AFTER the existing
   `CONVERSATION_SYSTEM_PROMPT` system turn so platform instructions remain first, while the compacted
   continuity context still sits near the front of the prompt. The summary is a deterministic,
   offline digest (no model call); durable facts/decisions extraction from chat remains a future
   enhancement.
4. Returns the concatenated array:
   `[system-message, compaction-summary-segment, ...recent-user-assistant-window]`.

The synthetic segment contains ONLY content from `ContextCompactionRecord.preservedFacts`,
`.decisions`, and `.openQuestions` — no raw message text, no file paths, no secrets (the
compaction builder applies `scanForSecrets` gate per ADR-0053 D4).

**Activation predicate** (the precise condition that triggers a behavioral change):

```
profile !== undefined AND rawHistory.length > MAX_CONTEXT_MESSAGES
```

Where `rawHistory = deps.store.listMessages(request.chatId)` — the full unsliced chat history.

**Byte-identity below threshold** is guaranteed by the `else` branch returning the EXACT return
value of the original `conversationForGateway(messages)` call, not a reconstructed equivalent.
No new computation occurs on the fast path. `buildGatewayMessages` (`chat-handlers.ts:L912`) is
updated to call the shim instead of `conversationForGateway` directly, but when the shim exits
the fast path, `buildGatewayMessages`'s callers receive an identical `GatewayConversationMessage[]`.

The compaction builder is called only in the slow path (long sessions with a profile). It is
pure and synchronous (no IO, no clock per ADR-0053 D7). The `orderedAt` counter is the current
message index from the history list (deterministic, no `Date.now()`).

The compaction records produced in W2 are in-memory only (per ADR-0053 D6). They are not
persisted in PR4. PR5 writes them to `EvidenceManifest.compaction?`.

### D4 — SHAPED-OBSERVATION WIRING in the harness: additive attach, no prompt change (PR4-W3)

The `ToolCallResult.shapedObservation?` field defined in PR3 is not yet populated by the live
harness in PR3. PR4 wires it additively.

In `keiko-harness/src/executor.ts`, after `runOneTool` returns a `ToolCallResult`, a new
optional step calls the appropriate shaper from `keiko-workflows/src/observations/` (already
a dependency of keiko-server; confirmed no new package edge for keiko-harness if we route the
shaper call through a seam in keiko-workflows that keiko-harness already imports). The shaped
observation is attached to the `ToolCallResult` via conditional-spread:

```ts
const shaped = maybeShape(result, call.id);  // pure, no IO, never throws
const enriched = shaped !== undefined
  ? { ...result, shapedObservation: shaped }
  : result;
```

The `role: "tool"` message built at `executor.ts:L204` continues to use `result.output` —
the byte-identical `summarizeCommand` output — for the `content` field the model sees. The
`shapedObservation` is attached to `enriched` but is NOT serialized into the `content` string.
The model-facing `content` field is unchanged.

The `contextBytes` check at `executor.ts:L239` uses `contextBytes([...ctx.messages, ...results, result])`.
The `result` in that check is the pre-enrichment `ToolCallResult`; enrichment happens after the
size check. Wait — this ordering must be explicit in the implementation to avoid inflating
`contextBytes`. The shaped observation is a keiko-internal field on `ToolCallResult`, NOT
serialized into the `ChatMessage.content` that `JSON.stringify` measures. `contextBytes` measures
`JSON.stringify(messages)` where each message has only `role` and `content`; `ToolCallResult` is
not a `ChatMessage`. The enriched `ToolCallResult.shapedObservation` is never present in the
`ChatMessage[]` array that `contextBytes` encodes. Byte accounting is unaffected.

The harness's `tool-observations` lane diagnostics are computed by the lane allocator
(`allocateContext`) after each tool turn, using the accumulated shaped observations in
`ctx.shapedObservations` (a new accumulator on `RunContext`). This is diagnostic-only in PR4:
the allocator output drives `ContextLaneDiagnostics` but does NOT yet gate eviction or replace
`ctx.messages` content. Full tool-observations lane eviction and shaped-prompt substitution are
deferred to a future PR (post-PR4) per the conservative approach.

**keiko-harness package edge**: `keiko-harness` already depends on
`@oscharko-dev/keiko-contracts` (for `ChatMessage`, `HarnessLimits`, etc.). The shaper types
(`ContextToolObservation`, `ShapedCommandObservation`, etc.) are in `keiko-contracts/src/context-observations.ts`.
The shaper functions are in `keiko-workflows`. `keiko-harness` does NOT currently depend on
`keiko-workflows`. Two options: (a) add a `keiko-harness → keiko-workflows` edge; (b) pass the
shaper as an injected port (`HarnessToolShaperPort`) into `RunContext`. We choose option (b):
an optional `tooldObservationShaper?: (result: ToolCallResult, toolCallId: string) => ContextToolObservation | undefined`
field on `HarnessLimits` or a new `HarnessShaperDeps` optional struct on `RunContext`. This
avoids a new package edge. The production wiring in `keiko-server` (which already imports
`keiko-workflows`) injects the shaper; existing harness tests that do not inject it are
unaffected. The shaper port is absent → fast-path (no shaping, byte-identical output).

### D5 — PROFILE PROVISIONING: `UiHandlerDeps.contextProfile?` default ON for diagnostics (PR4-W1)

We will add `contextProfile?: ContextProfile | undefined` as an optional field on `UiHandlerDeps`
(`deps.ts:L100`). `buildUiHandlerDeps` (`deps.ts:L730`) sets it to `DEFAULT_CONTEXT_PROFILE` in
production. This makes the diagnostics observer active by default for grounded calls, delivering
lane diagnostics with zero behavioral risk.

The history-compaction splice (D3) is separately gated: even with `contextProfile` present, the
splice only fires when `rawHistory.length > MAX_CONTEXT_MESSAGES = 24`. All existing tests have
short or fabricated histories well below 24 messages, so they remain byte-identical.

A test seam allows `contextProfile: undefined` to be injected in any test that needs to pin the
legacy no-profile code path.

**Why DEFAULT ON for diagnostics, not opt-in?** The diagnostics observer is non-mutating and its
cost is ~1-2ms (a pure `estimateTokens` pass over already-assembled text). Delivering measurable
lane diagnostics from day one (even before the splice) makes the quality gate `diagnosticsPresent`
loadbearing and surfaced immediately in evidence. Requiring explicit opt-in would leave the gate
scaffolded until a caller manually threads the profile, defeating the purpose of the W1 wave.

**Why NOT DEFAULT ON for the compaction splice?** The splice produces a genuine behavior change
(a different `GatewayConversationMessage[]`). It requires a session with > 24 messages to activate,
which no existing test vector exercises. However, because `UiHandlerDeps.contextProfile` defaults
to `DEFAULT_CONTEXT_PROFILE`, a real long session WILL see the splice in production after PR4
merges. This is intentional: it is the first PR where the milestone delivers user-observable value.
The gate `longSessionCompaction` covers this path with a synthetic corpus fixture of 30 messages.

### D6 — THE UNCHANGED-GUARANTEE MECHANISM: `contextProfile` absent or short history

The single predicate that makes the entire new path inert for existing callers:

```
contextProfile === undefined  ||  rawHistory.length <= MAX_CONTEXT_MESSAGES
```

When this predicate is true, EVERY new code path in PR4 is a no-op:

- Diagnostics observer: guarded by `if (deps.contextProfile !== undefined)` at the top of
  the observer call site in `assembleGroundedPack`. When absent, the pack is returned as
  `assemblePackFromReads` produced it, with no additional computation.
- Compaction splice: guarded by both `deps.contextProfile !== undefined` AND
  `rawHistory.length > MAX_CONTEXT_MESSAGES` in the `conversation-compaction.ts` shim.
  When either guard is false, `conversationForGateway` is called and its return value is
  returned verbatim — no object reconstruction, no spread, no copy.
- Shaped-observation attachment: guarded by `harnessShaperPort !== undefined`. When the port
  is absent (all existing harness tests), `runOneTool`'s result is used as-is, byte-identical.
- Lane diagnostics in the harness: computed only when `ctx.shapedObservations` is non-empty,
  which requires the shaper port to have been injected and to have produced at least one observation.

No existing test provisions a `ContextProfile` or a shaper port, so all existing tests exercise
only the legacy code paths and remain byte-identical.

### D7 — What PR4 does NOT do

- **Evidence persistence of compaction records** — `EvidenceManifest.compaction?` population and
  the `persistContextAssemblyEvidence` function are PR5. PR4's compaction records are in-memory
  and discarded at the end of the request.
- **Shaped-output substitution into model prompt** — the model-facing `ToolCallResult.output`
  remains `summarizeCommand` output. Full replacement of that string with a shaped observation
  rendering is a future PR.
- **Tool-observations lane eviction** — the allocator runs in diagnostic mode only; it does not
  yet evict or compact `role:tool` messages from the harness `ctx.messages`.
- **UI disclosure** — `ConversationBudgetBreakdown` lane fields and the `ContextStatusPanel`
  are PR6.
- **Injection-signal gating** — the `hasCriticalInjectionSignal` flag on shaped observations is
  recorded in diagnostics; it does not yet block or route tool calls in PR4 (that is a future
  behavioral change requiring its own ADR and gate).
- **Full browser observation shaping** — `ShapedBrowserObservation` remains forward-defined with
  no producer in PR4.

## Consequences

### Positive

- The grounded orchestrator gains lane/budget diagnostics (which evidence, how many tokens per
  lane, pressure level) with zero behavioral risk. The `diagnosticsPresent` gate becomes
  load-bearing in PR4.
- Long chat sessions (> 24 messages) receive structured compaction rather than silent hard-drop,
  preserving provenance-backed facts across the 24-message boundary for the first time.
- Shaped observations from PR3 are finally attached to live `ToolCallResult` instances,
  making `ToolCallResult.shapedObservation?` non-null in production for the first time.
- The harness accumulates `ContextLaneDiagnostics` for the `tool-observations` lane, enabling
  PR5 evidence persistence and PR6 UI display without further wiring.
- All existing tests remain byte-identical due to the `contextProfile` absent guard, with no
  required changes to existing test fixtures.

### Negative

- `buildUiHandlerDeps` gains one new field (`contextProfile`) increasing the `UiHandlerDeps`
  interface width further. The interface already carries ~20 fields; this adds one more.
- The diagnostics observer adds ~1-2ms per grounded call (pure `estimateTokens` pass). Accepted
  as negligible for the p95 assembly latency gate (≤ 25ms per ADR-0052 Metrics).
- The conversation compaction shim introduces a slow path in `buildGatewayMessages` for long
  sessions. The compaction builder is synchronous and pure (~1ms per ADR-0053 gate), adding
  negligible latency relative to the model call it precedes.
- The `HarnessShaperDeps` port approach (D4 option b) means the harness does not directly import
  shapers; teams working on the harness must know to inject the port. This is a documentation
  obligation, not a code constraint.

### Neutral

- Compaction records remain in-memory only in PR4 (consistent with PR2 and PR3). Teams relying
  on PR5 evidence persistence cannot use them yet for audit or UI.
- The `role:tool` message content is unchanged in PR4. The model sees the same summarizeCommand
  output as today. Users will not notice any difference in assistant responses in PR4.

## Measurable Acceptance Gates

All gates must pass before PR4 is merged.

1. **ac5ByteIdentical (HARD).** `buildGroundedGatewayMessages(question, pack, redactor)` is
   byte-identical with and without `contextProfile` present, for every existing grounded-qa test
   vector. Pinned in `scripts/check-context-quality.budget.json` as a required hard gate.

2. **noProfileUnchanged (HARD).** When `UiHandlerDeps.contextProfile` is `undefined` (injected
   in test), `buildGatewayMessages` returns the identical `GatewayConversationMessage[]` as before
   PR4. Verified by a test that compares the serialized output of pre-PR4 and post-PR4 paths on
   the same 10-message chat fixture.

3. **shortSessionByteIdentical (HARD).** A 24-message session (exactly `MAX_CONTEXT_MESSAGES`)
   with `contextProfile` present produces a byte-identical `GatewayConversationMessage[]` to the
   legacy `conversationForGateway` call. Verifies the `<= MAX_CONTEXT_MESSAGES` guard fires
   correctly.

4. **longSessionCompaction (REQUIRED).** A synthetic 30-message corpus fixture (> 24) with
   `contextProfile = DEFAULT_CONTEXT_PROFILE` produces a `GatewayConversationMessage[]` whose first
   element remains the system message, whose second element is the compaction summary segment
   (role: `"user"` — see refined D3, content is the labeled redacted digest of the dropped turns),
   and whose remaining elements match the last 24 user/assistant messages from the original history.
   The compaction summary must not contain any raw file path or secret shape.

5. **diagnosticsPresent (REQUIRED).** For every grounded-qa call with `contextProfile` present,
   the returned `ConnectedContextPack.diagnostics?.contextBudget` is non-null, carries a valid
   `ContextBudget` with at least the `repo-evidence` lane populated, and the
   `ContextAssemblyDiagnostics.budgetPressure` is a valid `ContextBudgetPressure` string. Verified
   against the existing grounded-qa corpus scenarios.

6. **firstRingPreserved (HARD).** `ConnectedContextPack.diagnostics?.rankedCandidates` remains
   populated from the lexical ring call (`grounded-orchestrator.ts:L448`) for all test vectors
   where it was populated before PR4. The diagnostics observer must NOT replace or clear this
   field (additive-only — `contextBudget?` is a new field, `rankedCandidates` is untouched).

7. **shapedObservationAttached (REQUIRED).** When a `HarnessShaperDeps` port is injected with
   `DEFAULT_CONTEXT_PROFILE`, `ToolCallResult.shapedObservation` is non-null for command tool
   calls and its `kind` is `"command"`. Verified by a harness integration test.

8. **contextBytesUnchanged (HARD).** `contextBytes(messages)` is unaffected by shaped
   observations: a `ChatMessage[]` produced by the harness with a shaper port injected measures
   the same byte length as one produced without, because `shapedObservation` is on `ToolCallResult`
   (keiko-internal), not on the `ChatMessage` `content` string.

9. **boundaryIntegrity (HARD).** `boundary.test.ts` remains green. `keiko-harness` does NOT add
   a new `keiko-workflows` import (the shaper is injected as a port). `keiko-server`'s existing
   `keiko-workflows` import covers the shaper functions; no new package edge.

10. **strictTsClean (HARD).** All new modules compile under the package `tsconfig.json` with no
    `as T`, no `!`, no ESLint suppressions, files ≤ 400 LOC, cyclomatic complexity ≤ 10 per function.

## Wave Breakdown (ordered)

**W1 — Grounded diagnostics observer + ContextPackDiagnostics.contextBudget? wiring + AC5 tests**

New module `keiko-server/src/grounded-context-diagnostics.ts`:
- `buildGroundedContextDiagnostics(pack: ConnectedContextPack, profile: ContextProfile): ContextAssemblyDiagnostics`
- Maps three lanes (system-contract, user-task, repo-evidence) from the assembled pack onto the
  eight-lane taxonomy; calls `estimateTokens` on each lane's text; computes `budgetPressure`.
- Returns a `ContextAssemblyDiagnostics` typed per `keiko-contracts/src/context-engineering.ts`.

Changes to existing files (additive only):
- `grounded-orchestrator.ts`: add `contextProfile?: ContextProfile | undefined` to `OrchestratorDeps`
  (L93–105); in `assembleGroundedPack` (L2055), after `assemblePackFromReads` returns, call
  `buildGroundedContextDiagnostics` and conditional-spread `contextBudget` into `pack.diagnostics`.
- `deps.ts`: add `contextProfile?: ContextProfile | undefined` to `UiHandlerDeps` (L100);
  `buildUiHandlerDeps` (L730) sets it to `DEFAULT_CONTEXT_PROFILE`.

Gates added: `ac5ByteIdentical` (hard), `diagnosticsPresent` (required), `firstRingPreserved` (hard).

Tests: `grounded-context-diagnostics.test.ts` — pure unit (no IO); 12 test cases covering three-lane
population, `budgetPressure` classification, observer-absent fast-path returns identical pack.

**W2 — Chat history-compaction splice + byte-identity-below-threshold tests**

New module `keiko-server/src/conversation-compaction.ts`:
- `buildCompactedConversation(deps: UiHandlerDeps, chatId: string): GatewayConversationMessage[]`
- Implements the activation predicate from D3; calls `buildCompactionRecords` from `keiko-workflows`
  for the sliced-off prefix; builds the synthetic compaction-summary segment; returns the
  concatenated array or falls through verbatim.

Changes to existing files (additive):
- `chat-handlers.ts`: `buildGatewayMessages` (L912) calls `buildCompactedConversation` instead of
  calling `conversationForGateway` directly. The new function's fast-path returns the same result,
  so `buildGatewayMessages`'s callers are unaffected on short sessions.

Gates added: `noProfileUnchanged` (hard), `shortSessionByteIdentical` (hard),
`longSessionCompaction` (required).

Tests: `conversation-compaction.test.ts` — 20 test cases covering 10-, 24-, and 30-message
fixtures with and without profile; compaction summary content checks; path-free and secret-free
assertion on summary content.

**W3 — Harness shaped-observation attach + contextBytes lane accounting**

Changes to `keiko-harness/src/context.ts`: add optional `shapedObservations: ContextToolObservation[]`
accumulator to `RunContext` (not serialized, not part of `contextBytes` input).

Changes to `keiko-harness/src/executor.ts`: after `runOneTool` returns, call the optional shaper
port to produce and attach `shapedObservation` to an enriched result; accumulate into
`ctx.shapedObservations`; the `ChatMessage` built at L204 uses `result.output` unchanged.

New type in `keiko-harness` (or its types module): `HarnessShaperPort` — the optional injected
shaper function signature. No `keiko-workflows` import.

Production wiring: the run launcher in `keiko-server` (the code that constructs `RunContext`)
injects the shaper port by calling `shapeCommandObservation` etc. from `keiko-workflows`. This is
already in keiko-server's import graph.

Gates added: `shapedObservationAttached` (required), `contextBytesUnchanged` (hard).

Tests: `executor.test.ts` additions — inject a fake shaper port, verify `shapedObservation` is
populated; verify `contextBytes` is unaffected; verify fast-path with absent port is byte-identical.

**W4 — Gate consolidation: promote to measured, add corpus fixture for long-session compaction**

`scripts/check-context-quality.mjs`:
- Promote `orchestratorDiagnosticsPresent` from scaffolded to measured.
- Add `ac5ByteIdentical` as a required hard gate (evaluates the two-run comparison from W1).
- Add `longSessionCompaction` as a required gate (30-message synthetic corpus).
- Add `noProfileUnchanged` and `shortSessionByteIdentical` as hard gates.

`scripts/check-context-quality.budget.json`: add threshold entries for each new gate.

Corpus: add a 30-message synthetic chat fixture to exercise the long-session compaction path.

Tests for the gate evaluators themselves: `check-context-quality.test.mjs` additions.

## Self-Critique

### Pass 1 — Devil's Advocate

**Is the single-source grounded wire output PROVABLY byte-identical?**

Yes. `buildGroundedGatewayMessages` (`grounded-qa.ts:L630`) reads only `pack.files`, `pack.budget`,
and the question/redactor inputs. The diagnostics observer populates only `pack.diagnostics.contextBudget?`,
which `buildGroundedGatewayMessages` does not read. The mechanical gate `ac5ByteIdentical` asserts
this by calling the function twice (with and without profile) on the same pack and comparing the
serialized output. No reasoning required — the gate makes it mechanically verified.

**Is the short-session chat output PROVABLY byte-identical?**

Yes. The `conversation-compaction.ts` shim has exactly one conditional branch for the slow path:
`if (profile !== undefined && rawHistory.length > MAX_CONTEXT_MESSAGES)`. The `else` branch
returns `conversationForGateway(messages)` — the exact same call and return value as today. No
intermediate copy, no spread, no transformation. The gate `shortSessionByteIdentical` asserts this
on a 24-message fixture with profile present.

**Does the diagnostics observer avoid mutating selection or prompt?**

Yes. The observer is called after `assemblePackFromReads` completes. It reads from the pack, calls
`estimateTokens` on already-assembled text, and returns a `ContextAssemblyDiagnostics`. The
conditional-spread at the attach point produces a new pack object with `diagnostics.contextBudget?`
populated; the original `pack.files`, `pack.budget`, `pack.stableId`, and all other fields are
reference-identical (copied by value in the spread, but content-identical). The pack's excerpt
content is not re-filtered, re-ranked, or re-selected.

**Are multi-source and hybrid paths covered?**

Multi-source: `retrieveConnectedContextPack` is the entry point. The optional `contextProfile?`
in `OrchestratorDeps` threads naturally. The diagnostics observer fires inside `assembleGroundedPack`
for each per-scope pack. The multi-source answer call receives the enriched packs and calls
`promptBudgetedMessages` on their evidence content, unchanged. Gate `ac5ByteIdentical` covers the
single-source path; an explicit multi-source fixture is added to W4 corpus.

Hybrid: `grounded-qa-hybrid.ts` similarly calls `retrieveConnectedContextPack` per connector and
composes. The same optional `contextProfile?` threading applies. Confirmed by the module header at
line 4: "paths are untouched so their wire output stays byte-identical."

**No new package edge?**

Confirmed. `keiko-server` → `keiko-workflows` and `keiko-server` → `keiko-contracts` already exist.
`keiko-harness` does NOT import `keiko-workflows` (D4 justifies this was rejected). The shaper is
injected as a port. `boundary.test.ts` gate (ADR-0019) pins this.

**Is the new path fully inert when no profile is present?**

Yes, by the mechanism in D6: every new code path in PR4 begins with `if (deps.contextProfile !== undefined)`,
`if (profile !== undefined && rawHistory.length > MAX_CONTEXT_MESSAGES)`, or
`if (ctx.harnessShaperPort !== undefined)`. These are the FIRST statements in each new function.
When the guard is false, the function returns or the existing code path runs verbatim. No other
code change in PR4 affects the output when the guard is false.

### Pass 2 — Clarity

Is the decision concrete enough for a new engineer? A new engineer can find:
- `grounded-context-diagnostics.ts` — the observer (new module, ≤ 400 LOC, pure).
- `conversation-compaction.ts` — the splice (new module, ≤ 400 LOC, pure/sync).
- The optional `contextProfile?` field on `OrchestratorDeps` and `UiHandlerDeps`.
- The `HarnessShaperPort` type in `keiko-harness`.
All implementation sites and signatures are named and located.

Are the consequences honest? Yes — the LOC addition to existing files is minimal (one optional
field, one call-site substitution per file). The behavioral change for long sessions is explicitly
disclosed as the intended user-observable change. The ~2ms diagnostics overhead is acknowledged.

Did we cite real alternatives? D4 explicitly considered two options for the harness package edge
and chose the port injection over a new edge with justification. The alternative of making the
splice default-off (opt-in only) was implicitly considered and rejected (D5 explains why default-on
for diagnostics is correct, while default-on for the splice is safe because the activation threshold
is high).

Is the ADR free of undefined jargon? All referenced functions cite file:line. Every new term
(activation predicate, compaction-summary segment, shaper port) is defined in its decision section.

## Alternatives Considered

### Alternative 1: Inline new logic into existing orchestrator and handler files

Add the diagnostics observer directly to `assembleGroundedPack` in `grounded-orchestrator.ts`
(2,178 LOC) and the compaction splice to `buildGatewayMessages` in `chat-handlers.ts` (1,086 LOC).

- **Pros**: no new files; existing callers see changes in one place.
- **Cons**: both files are at or near the 400-LOC file cap for new modules (CLAUDE.md). Adding
  substantial logic to them would push them further past it. The diagnostics observer and
  compaction splice are pure functions that are more testable as isolated units. Inlining them
  increases the cyclomatic complexity of already-complex functions.
- **Why rejected**: the CLAUDE.md quality bar prohibits adding complexity to files that already
  exceed the cap. New sibling modules preserve testability and keep the existing files stable.

### Alternative 2: Make the compaction splice opt-in (flag in request body)

Add a `contextEngineering?: boolean` flag to `SendDesktopChatRequest` and activate the splice only
when the client sends it.

- **Pros**: zero risk of affecting existing sessions; pure opt-in.
- **Cons**: requires a client API change that is out of scope for PR4. Existing sessions with >24
  messages silently hard-drop history regardless; the splice is a strict improvement. The activation
  threshold (`> MAX_CONTEXT_MESSAGES`) already provides the same protection as an opt-in flag:
  no session at or below 24 messages is affected. An additional opt-in flag doubles the guarding
  without adding safety.
- **Why rejected**: the `contextProfile !== undefined` guard (D6) already provides the exact same
  protection as a per-request opt-in flag. The profile is provisioned server-side in
  `buildUiHandlerDeps`; callers do not need to know about it. Adding a client-facing flag is
  scope creep.

### Alternative 3: Add a keiko-harness → keiko-workflows package edge for the shaper

Allow `keiko-harness` to import `shapeCommandObservation` directly from `keiko-workflows`.

- **Pros**: simpler than a port; no injection indirection.
- **Cons**: `keiko-harness` is a domain-logic package that today depends only on `keiko-contracts`
  and `keiko-model-gateway`. Adding a `keiko-workflows` dependency would make the harness depend
  on the full workflow layer (allocator, compaction builder, rehydration, observations) — a
  one-way ratchet that enlarges the harness test surface and potentially inflates the harness
  bundle. The port pattern (used by `ModelPort` and `ToolPort` in the same codebase) is the
  established keiko harness pattern for injecting domain-logic dependencies.
- **Why rejected**: the port injection approach is the harness's own established pattern and avoids
  a new package edge that `boundary.test.ts` would need to whitelist. The production wiring in
  `keiko-server` (which already imports both `keiko-harness` and `keiko-workflows`) is the correct
  tier for injecting the shaper.

### Alternative 4: Default the context profile OFF (undefined) and require explicit activation

Set `UiHandlerDeps.contextProfile` to `undefined` by default in `buildUiHandlerDeps`, requiring a
caller to opt in by threading a profile.

- **Pros**: maximum conservatism; zero risk of the compaction splice activating unexpectedly.
- **Cons**: the diagnostics observer would also remain inactive, leaving `diagnosticsPresent` a
  permanently scaffolded gate. The compaction splice is already gated behind both the profile
  presence AND the > 24 message threshold. With the profile off, long sessions continue to silently
  hard-drop history — the status quo that the milestone exists to fix. The behavioral change is
  controlled by the threshold, not just the profile flag.
- **Why rejected**: defaulting ON for diagnostics delivers immediate measurable value (lane budget
  observability) with zero behavioral risk. Defaulting ON for the compaction splice is safe because
  the > 24 message threshold is the effective activation gate. Requiring an additional explicit
  activation would delay the milestone's user-observable value without adding safety.

## Related

- ADR-0052: defines `ContextProfile`, `DEFAULT_CONTEXT_PROFILE`, `estimateTokens`, the eight-lane
  taxonomy, and the allocator. PR4 wires these into the live paths.
- ADR-0053: defines `buildCompactionRecords` and the in-memory compaction record contract. PR4
  calls `buildCompactionRecords` in the conversation splice (D3). Evidence persistence deferred to PR5.
- ADR-0054: defines `ToolCallResult.shapedObservation?` and the shapers. PR4 wires the shapers
  into the harness tool-call loop via an injected port (D4).
- ADR-0019: modular package architecture and `boundary.test.ts`. D4 justifies no new package edge
  for `keiko-harness → keiko-workflows`.
- ADR-0022: connected-context privacy. The diagnostics attach point carries only counts and token
  estimates, never paths or content — consistent with the path-free projection rule.
- ADR-0048: evidence artifact confidentiality. Compaction records in PR4 are in-memory only;
  PR5 routes them through the `redact`/`applyRetention`/`writeSideFile` stack.
- `packages/keiko-server/src/grounded-orchestrator.ts:L80–84` — `GroundedAnswerer` seam.
- `packages/keiko-server/src/grounded-orchestrator.ts:L86–105` — `OrchestratorInput` + `OrchestratorDeps`
  (additive `contextProfile?` field target).
- `packages/keiko-server/src/grounded-orchestrator.ts:L2055,L2074` — `assembleGroundedPack`
  (observer attach point after `assemblePackFromReads`).
- `packages/keiko-server/src/grounded-orchestrator.ts:L2141` — `runGroundedExploration` entry point.
- `packages/keiko-server/src/grounded-qa.ts:L430` — `APPROX_BYTES_PER_TOKEN = 4` (AC5 boundary).
- `packages/keiko-server/src/grounded-qa.ts:L476–512` — `promptBudgetedMessages` (AC5 invariant function).
- `packages/keiko-server/src/grounded-qa.ts:L630–635` — `buildGroundedGatewayMessages` (AC5 boundary).
- `packages/keiko-server/src/grounded-qa-multi-source.ts:L4–8` — AC5 comment; imports
  `buildGroundedGatewayMessages` from `grounded-qa.ts` (L73).
- `packages/keiko-server/src/grounded-qa-hybrid.ts:L4–8` — AC5 comment for hybrid path.
- `packages/keiko-server/src/chat-handlers.ts:L86` — `MAX_CONTEXT_MESSAGES = 24`.
- `packages/keiko-server/src/chat-handlers.ts:L294–308` — `conversationForGateway` (splice target).
- `packages/keiko-server/src/chat-handlers.ts:L912–919` — `buildGatewayMessages` (call-site to update).
- `packages/keiko-server/src/deps.ts:L100` — `UiHandlerDeps` (additive `contextProfile?` field target).
- `packages/keiko-server/src/deps.ts:L730` — `buildUiHandlerDeps` (provisioning site).
- `packages/keiko-harness/src/context.ts:L64` — `contextBytes()` (JSON byte measure; unchanged).
- `packages/keiko-harness/src/executor.ts:L195–220` — `runOneTool` (shaper attach site).
- `packages/keiko-harness/src/executor.ts:L204` — `role: "tool"` message build (content unchanged).
- `packages/keiko-harness/src/executor.ts:L239` — `contextBytes` check (must precede enrichment).
- `packages/keiko-contracts/src/connected-context.ts:L304–308` — `ContextPackDiagnostics.contextBudget?`
  (additive attach point already defined in PR1).
- `packages/keiko-workflows/src/context-budget/index.ts` — `allocateContext`, `DEFAULT_CONTEXT_BUDGET`,
  `buildCompactionRecords`, `rehydrateHandle`.
- `packages/keiko-workflows/src/observations/index.ts` — `shapeCommandObservation`,
  `shapeTestObservation`, `shapeSearchObservation`.
- `scripts/check-context-quality.mjs` + `scripts/check-context-quality.budget.json` — gate harness
  (W4 additions).

## Date

2026-06-23
