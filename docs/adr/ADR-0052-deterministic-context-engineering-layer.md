# ADR-0052: Deterministic context-engineering layer (context profile, lanes, budget allocator)

## Status

Proposed

## Version

0.2.0

## Context

Keiko targets heterogeneous, customer-hosted, model-agnostic coding models. The new context-engineering
milestone introduces a **deterministic, offline-first** layer that fits a default **128,000-token effective
input budget** across an explicit set of context lanes, with NO embeddings, NO network, NO new dependencies,
and NO rewrites of the existing paths. Every new contract type must be **additive and backward compatible**:
existing callers that pass no profile and read no new diagnostics behave exactly as they do today. M5
semantic/reranking is out of scope. The guiding principle is simple, debuggable, measurable over speculative
abstraction.

Keiko has **two context paths**, established by a full read-only mapping:

1. **Grounded repo-QA.** `keiko-server/grounded-orchestrator.ts -> grounded-qa.ts -> GroundedAnswerer seam ->
   model`. The budget is the `ExplorationBudget`
   (`packages/keiko-contracts/src/connected-context.ts:108`, default
   `packages/keiko-contracts/src/connected-context.ts:118` with `modelInputTokensMax: 32_000`,
   `excerptBytesMax: 131_072`). Lanes present today are effectively only system, user-task, and repo-evidence.
   This path is bounded and short-lived.

2. **Agentic harness loop.** `keiko-harness` (`executor.ts` / `loop.ts` / `planner.ts`) `-> ToolPort -> tool
   exec -> role:tool messages`; desktop chat in `keiko-server/chat-handlers.ts`. History today is a hard
   last-24-message slice (`MAX_CONTEXT_MESSAGES = 24`) with **zero compaction**; the budget is
   `HarnessLimits.maxContextBytes = 512KB` measured by `keiko-harness/context.ts` `contextBytes()` at
   `packages/keiko-harness/src/context.ts:64` via `JSON.stringify` byte length. This is the path where
   compaction, tool-observation lanes, working-memory, history-summary, verification-evidence, and the true
   128k window live.

**Token reality.** There is no tokenizer anywhere in the repository. Historical approximations diverged:
`APPROX_BYTES_PER_TOKEN = 4` (`grounded-qa.ts`), `chars / 4` (editor), and `word * 1.3`
(`keiko-memory-retrieval/context.ts` `estimateTokens`). A former browser composer estimator also used
`bytes / 4`, but that UI estimate was removed because it was not model-tokenizer-specific and confused users.
Mixing ratios across lanes corrupts a shared budget: a lane estimated at `word * 1.3` and a lane estimated at
`bytes / 4` cannot be summed into one honest allocation. The milestone therefore needs **one** estimator.

## Decision

We will introduce a deterministic context-engineering vocabulary in `@oscharko-dev/keiko-contracts`, a single
canonical token estimator, an explicit eight-lane taxonomy with a fixed allocation order, and a pure lane
allocator in `@oscharko-dev/keiko-workflows`. The full type vocabulary is defined now so the additive surface
is stable; only the PR1 subset is implemented first.

### D1 — One conservative, deterministic token estimator in keiko-contracts

We will define a single `estimateTokens(text: string): number` in `keiko-contracts` and use it uniformly across
every lane. Properties:

- **Deterministic**: same input → same output, no clock, no randomness, no locale dependence.
- **Conservative (over-estimates slightly)**: it computes UTF-8 byte length and divides by a conservative
  bytes-per-token divisor, then **rounds up** and adds a small fixed per-segment structural overhead so the
  estimate never under-counts a real provider tokenization for typical source/markdown text. Over-estimation is
  the safe direction: it makes the allocator fit *fewer* tokens than the provider would, never *more*.
- **Total / never throws**: empty string → a defined small constant (the structural overhead, never `NaN` or a
  divide-by-zero), huge input → a finite integer, non-ASCII / emoji / surrogate pairs → counted by UTF-8 bytes
  using `TextEncoder` with a `string.length` fallback when `TextEncoder` is absent. It must **never fail a
  workflow** if exact provider tokenization is unavailable — it is the only available token signal.
- **Test-covered**: empty, ASCII, multi-byte, surrogate-pair, and very large fixtures, plus a monotonicity
  property (appending text never lowers the estimate) and a conservatism property (estimate ≥ a known
  lower-bound ratio of the byte length).

The browser composer no longer carries a separate `bytes / 4` UI pressure estimator. The 128k allocator consumes
the lane model and the canonical `estimateTokens`; composer history controls are intentionally not a token-budget
display.

### D2 — The model-agnostic ContextProfile and DEFAULT_CONTEXT_PROFILE

We will define a `ContextProfile` carrying `maxInputTokens`, a conservative `reservedOutputTokens`, a
`safetyMarginTokens`, and a derived `effectiveInputBudget = maxInputTokens − reservedOutputTokens −
safetyMarginTokens`. `DEFAULT_CONTEXT_PROFILE` pins `maxInputTokens = 128_000`. The profile is the **only**
place the window size lives, so customer-hosted models with different windows are handled by threading a
profile-derived override (through `OrchestratorInput.budget` for path 1 and the harness limits for path 2) and
**never** by editing call sites. We do **not** raise the existing `DEFAULT_EXPLORATION_BUDGET.modelInputTokensMax`
default of `32_000` (`connected-context.ts:122`) — that is a breaking change to path 1; profile-derived
overrides thread through `OrchestratorInput.budget` as today.

### D3 — Eight-lane taxonomy with a fixed allocation order

We will encode exactly eight lanes via `ContextLaneId`:

`system-contract` (non-evictable, small, bounded) · `user-task` (verbatim where feasible) · `active-plan` ·
`repo-evidence` · `tool-observations` · `working-memory` · `history-summary` · `verification-evidence`.

Each lane (`ContextLane`) carries `id`, `purpose`, `priority`, a token `budget`, an `eviction` policy, and
optional `diagnostics`. The allocation order is fixed and deterministic:

1. Non-evictable `system-contract` + `user-task` first (reserved off the top; never evicted).
2. `active-plan` + `working-memory` second.
3. `repo-evidence` third — hard per-lane caps, filled in relevance order via
   `selectScoredTextByByteBudget` (`packages/keiko-workspace/src/contextPack.ts:53`).
4. Recent **failing** `tool-observations` fourth.
5. Compressed `history-summary` + older `tool-observations` last.

**Lost-in-the-middle mitigation** is a layout rule, not a new type: a compact task/decision summary is placed
near the prompt START and the direct next-step evidence near the prompt END, with no large duplication. This is
recorded as an allocator obligation and an acceptance gate, not encoded as a contract field.

Lane coverage of the milestone preservation targets is total: user instructions → `user-task`; active plan →
`active-plan`; current diff → `working-memory` (+ `repo-evidence` for surrounding source); failing tests →
`verification-evidence` (+ recent failing `tool-observations`); repo-evidence references → `repo-evidence`.

### D4 — Where each type lives

- **`keiko-contracts`** owns the entire vocabulary (pure readonly interfaces, frozen constants, hand-written
  validators following the `MemoryValidation<T>` / coding-context `isRecord` + predicate-array pattern). A new
  `context-engineering.ts` module, split into `context-engineering-validation.ts` if it would exceed the 400-LOC
  file cap (the `memory-validation.ts` / `memory-operations-validation.ts` split is the precedent at
  `memory-validation.ts:11`). A subpath export `./context-engineering` is added to `package.json` and the barrel
  re-exports with explicit `export type`.
- **`keiko-workflows`** owns the **allocator** (see D6). It may depend on `keiko-contracts` (correct tier
  direction) and reuse `selectScoredTextByByteBudget` from `keiko-workspace`.
- No new type forces a `keiko-contracts` sibling import; `boundary.test.ts` (ADR-0019) stays green.

### D5 — Additive attach points (exact seams)

All of these are **optional** fields populated by conditional-spread at the producer, absent on legacy callers:

- `connected-context.ts`: extend `ContextPackDiagnostics` (`connected-context.ts:301`, currently only
  `rankedCandidates`) with `contextBudget?: ContextBudget`. `ConnectedContextPack.diagnostics?`
  (`connected-context.ts:282`) already optional, so legacy packs are unaffected; the pack `stableId` continues
  to hash only scope/query/atom ids, never diagnostics.
- `bff-wire.ts`: extend `GroundedAnswerContextPackSummary` (`bff-wire.ts:603`, path-free counts-only) with
  `contextSummary?` (an aggregate, path-free projection of the budget — token totals and per-lane counts only,
  never paths or excerpt content). `buildGroundedAnswerContextPackSummary` (`bff-wire.ts:683`) spreads it only
  when present, exactly as it does for `rankingSummary`.
- `evidence.ts`: extend `EvidenceManifest` (`evidence.ts:313`) with `contextAssembly?: ContextAssemblyDiagnostics`
  and `compaction?: ContextCompactionRecord[]` (latter is later-PR). No `evidenceSchemaVersion` bump (mirrors the
  additive `connectedContext?` / `governedHandoff?` precedent). The `EvidenceConnectedContextAudit`
  `rankedCandidates?` additive precedent (`evidence.ts:291`) and the `workspaceRootAuditId` hashing pattern apply;
  `AuditRedactionConfig` (`evidence.ts:335`) and `DEFAULT_RETENTION` are reused, not re-invented.
- `coding-context.ts`: `CodingContextBudget` / `CODING_CONTEXT_BUDGETS` (`coding-context.ts:161`,`:167`) is the
  pattern reference for per-lane caps; not modified.

### D6 — Allocator placement: keiko-workflows

We will place the deterministic lane allocator as a **new pure, no-IO module in `keiko-workflows`** (alongside
`planner/governor.ts`), not in `keiko-server`.

Rationale:

- It must depend on `ContextProfile` (a `keiko-contracts` type). `keiko-workflows` already imports
  `keiko-contracts` (`planner/governor.ts:7`), so the dependency direction is correct.
- It reuses `selectScoredTextByByteBudget` from `keiko-workspace`. `keiko-workspace` is a **lower tier** than
  `keiko-workflows`, so an allocator in `keiko-workflows` may depend on both contracts and workspace without
  violating ADR-0019. (An allocator in `keiko-workspace` could not depend on `keiko-contracts` context types
  without inverting the tier, and an allocator in `keiko-server` would be untestable as a pure unit and would
  leak policy into the orchestration layer.)
- It mirrors the immutable-budget state-machine pattern of `createGovernor` / `applyUsage`
  (`planner/governor.ts:86`,`:101`): every allocation step returns a fresh state object; no mutation, no
  persistence, callers persist via the evidence ledger.

Both context paths consume the same allocator: path 1 maps its three present lanes onto the taxonomy (the
remaining lanes are empty), path 2 uses the full eight.

### D7 — Strict-TS and boundary constraints

Every new type compiles under `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, and
`noUncheckedIndexedAccess`. Optional fields are emitted by conditional-spread at producers (never
`prop: T | undefined` assignment); no `as T`, no `!`. Functions stay ≤ 10 cyclomatic complexity, ≤ 50 LOC; files
stay ≤ 400 LOC (split the validation module if needed). Validators return the established
`{ ok: true } | { ok: false; reasons }` / `MemoryValidation<T>` envelope.

### D8 — Explicitly deferred to later PRs

`ContextCompactionRecord` and `ContextRehydrationHandle` are **defined now** (so the surface is stable) but
**implemented later**. Also deferred: tool-observation shaping (selection/summarization of `role:tool`
messages), the evidence wiring of `contextAssembly?` / `compaction?`, and grounded context-status UI wiring.
PR1 implements: `ContextProfile`, `ContextBudget`, `ContextLane`,
`ContextLaneId`, `ContextLaneDiagnostics`, `ContextAssemblyDiagnostics`, `estimateTokens`,
`DEFAULT_CONTEXT_PROFILE`, the `ContextPackDiagnostics.contextBudget?` attach point, and the allocator.

## Consequences

### Positive

- One honest token currency across all lanes; budget accounting stops silently corrupting when ratios mix.
- The 128k window lives in one constant; customer models with other windows are a profile override, not a code
  change.
- Every additive field is optional and absent on legacy callers, so both paths and all existing tests are
  byte-for-byte unaffected until a producer opts in.
- The allocator is a pure unit in `keiko-workflows`, fully testable without IO and reusing two existing,
  battle-tested primitives (`selectScoredTextByByteBudget`, the governor immutability pattern).
- Defining the full vocabulary up front makes later PRs purely implementational — no public-surface churn.

### Negative

- A conservative estimator under-fills the window relative to the true provider tokenization, leaving some
  budget unused. Accepted: under-fill is safe; over-fill risks a provider hard-rejection mid-workflow.
- Defining `CompactionRecord` / `RehydrationHandle` before implementing them is a small amount of forward
  design; mitigated by marking them deferred and keeping them minimal.
- Eight lanes plus diagnostics is more vocabulary than the three lanes path 1 uses today; path 1 carries empty
  lanes it does not populate.

### Neutral

- The lost-in-the-middle layout is an allocator obligation and a gate, not a contract field.

## Acceptance gates (measurable)

1. **Backward compatibility.** A legacy `ConnectedContextPack` / `EvidenceManifest` /
   `GroundedAnswerContextPackSummary` fixture with no new fields validates and round-trips unchanged; the pack
   `stableId` is identical before and after the diagnostics extension. Pinned by `connected-context.test.ts`
   absent-field guards.
2. **Estimator totality.** `estimateTokens` returns a finite non-negative integer for empty, ASCII, multi-byte,
   surrogate-pair, and ≥ 1MB inputs and never throws; a monotonicity test (append never lowers) and a
   conservatism test (estimate ≥ byteLength / divisor) pass.
3. **Single estimator.** No lane in the allocator computes tokens by any ratio other than `estimateTokens`;
   asserted by a test that the allocator imports only the canonical estimator.
4. **Budget identity.** For `DEFAULT_CONTEXT_PROFILE`,
   `effectiveInputBudget === maxInputTokens − reservedOutputTokens − safetyMarginTokens` and is `> 0`; a
   property test over generated profiles asserts the allocator never returns a per-lane sum exceeding
   `effectiveInputBudget`.
5. **Allocation order + non-eviction.** Given over-budget inputs, `system-contract` and `user-task` survive,
   eviction occurs in the fixed order, and the result is deterministic across runs (same input → same lanes).
6. **Boundary integrity.** `boundary.test.ts` stays green; the allocator in `keiko-workflows` imports only
   `keiko-contracts` and `keiko-workspace`.
7. **Strict-TS clean.** The new modules compile under the package `tsconfig` with no `as` / `!` and no ESLint
   suppressions, files ≤ 400 LOC.

## Alternatives Considered

### Alternative 1: Put the allocator in keiko-server next to the orchestrators

- **Pros**: closest to both consumers; no cross-package wiring.
- **Cons**: not a pure unit (server pulls IO and the gateway), can't be unit-tested in isolation, leaks
  allocation policy into orchestration, and would be re-implemented for the harness path.
- **Why rejected**: the allocator is pure policy; `keiko-server` is the wrong tier and would force duplication
  across the two paths. `keiko-workflows` already owns the comparable `governor` policy unit.

### Alternative 2: Reuse a browser composer estimate as the 128k allocator

- **Pros**: one fewer module.
- **Cons**: the removed browser estimate was a `bytes / 4` pressure hint, not a lane allocator with eviction
  order; forking that style of estimate would entangle UI affordances with workflow allocation and re-introduce
  `bytes / 4` as the budget currency.
- **Why rejected**: the milestone explicitly forbids forking it; lane allocation with non-eviction and a fixed
  order is a different concern from a UI pressure read-out.

### Alternative 3: Define only the PR1 subset now, add CompactionRecord / RehydrationHandle later

- **Pros**: avoids any forward design; strictly YAGNI.
- **Cons**: later PRs would add **new public types** to a published contract surface, risking a non-additive
  shape change to `EvidenceManifest` (`compaction?`) discovered late, after consumers already shipped.
- **Why rejected**: the milestone requires a **stable additive surface**. Defining (not implementing) the two
  deferred types now costs little and guarantees later PRs are purely implementational. This is surface
  stability, not speculative abstraction.

### Alternative 4: Introduce a real tokenizer dependency for exact counts

- **Pros**: accurate token counts; no over/under-estimation.
- **Cons**: violates the no-new-dependencies and offline-first constraints; tokenizers are model-specific and
  this is a model-agnostic product, so "exact" would be exact for the wrong model.
- **Why rejected**: out of scope by milestone constraint; a conservative model-agnostic estimator is the correct
  contract for heterogeneous customer-hosted models.

## Interface specification

This is the full additive vocabulary. Each type is tagged **[PR1]** (implemented first) or **[LATER]** (defined
now for surface stability, implemented in a later PR). All optional fields are emitted via conditional-spread at
producers; the declared `prop?: T | undefined` form is the house pattern (compatible with
`exactOptionalPropertyTypes`).

```ts
// packages/keiko-contracts/src/context-engineering.ts
// Pure readonly contracts for the deterministic context-engineering layer. No IO, no clock,
// no randomness, no sibling @oscharko-dev/keiko-* import. Estimator is the single canonical
// token currency; the allocator that consumes ContextProfile lives in keiko-workflows.

export const CONTEXT_ENGINEERING_SCHEMA_VERSION = "1" as const;

// Provenance string recording which estimator produced a profile's counts (the estimator
// function itself cannot be a JSON-serializable contract field). Default for estimateTokens.
export const DEFAULT_TOKEN_ESTIMATOR_ID = "keiko-conservative-utf8-v1" as const;

// ─── Lane identity (the eight lanes) ──────────────────────────────────────── [PR1]
export type ContextLaneId =
  | "system-contract"
  | "user-task"
  | "active-plan"
  | "repo-evidence"
  | "tool-observations"
  | "working-memory"
  | "history-summary"
  | "verification-evidence";

export const CONTEXT_LANE_IDS: readonly ContextLaneId[] = [
  "system-contract",
  "user-task",
  "active-plan",
  "repo-evidence",
  "tool-observations",
  "working-memory",
  "history-summary",
  "verification-evidence",
] as const;

// Eviction policy per lane. "none" => non-evictable (reserved off the top).
export type ContextEvictionPolicy =
  | "none"
  | "summarize-then-drop"
  | "drop-oldest"
  | "drop-lowest-score";

export const CONTEXT_EVICTION_POLICIES: readonly ContextEvictionPolicy[] = [
  "none",
  "summarize-then-drop",
  "drop-oldest",
  "drop-lowest-score",
] as const;

export type ContextBudgetPressure = "low" | "moderate" | "high" | "exceeded";

// ─── Context profile ──────────────────────────────────────────────────────── [PR1]
// Model-agnostic. The ONLY place the window size lives. effectiveInputBudget is derived,
// never authored independently.

// Optional, opaque provider/model metadata. Never drives behavior; for disclosure only.
export interface ContextModelMetadata {
  readonly id?: string | undefined;
  readonly provider?: string | undefined;
  readonly notes?: string | undefined;
}

export interface ContextProfile {
  readonly schemaVersion: typeof CONTEXT_ENGINEERING_SCHEMA_VERSION;
  readonly maxInputTokens: number;
  readonly reservedOutputTokens: number;
  readonly safetyMarginTokens: number;
  readonly effectiveInputBudget: number;
  // Provenance of the token counts (which estimator produced them). REQUIRED.
  readonly tokenEstimatorId: string;
  // Opaque provider/model metadata. OPTIONAL, never drives behavior; omitted on the default.
  readonly model?: ContextModelMetadata | undefined;
}

// Conservative defaults. 128k window, 8k reserved for output, 4k safety margin =>
// 116k effective input budget. Frozen. `model` is intentionally omitted (optional).
export const DEFAULT_CONTEXT_PROFILE: ContextProfile = {
  schemaVersion: CONTEXT_ENGINEERING_SCHEMA_VERSION,
  maxInputTokens: 128_000,
  reservedOutputTokens: 8_000,
  safetyMarginTokens: 4_000,
  effectiveInputBudget: 116_000,
  tokenEstimatorId: DEFAULT_TOKEN_ESTIMATOR_ID,
} as const;

// ─── Per-lane budget allocation (one row per lane) ────────────────────────── [PR1]
export interface ContextLaneBudget {
  readonly laneId: ContextLaneId;
  readonly priority: number; // lower = allocated earlier; matches allocation order
  readonly maxTokens: number; // hard per-lane cap
  readonly minReservedTokens: number; // reserved off the top (non-evictable lanes > 0)
  readonly eviction: ContextEvictionPolicy;
}

// The full budget plan: the profile plus one row per lane. The sum of maxTokens MAY exceed
// effectiveInputBudget (lanes compete); the allocator enforces effectiveInputBudget at runtime.
export interface ContextBudget {
  readonly schemaVersion: typeof CONTEXT_ENGINEERING_SCHEMA_VERSION;
  readonly profile: ContextProfile;
  readonly lanes: readonly ContextLaneBudget[];
}

// ─── A populated lane (after allocation) ──────────────────────────────────── [PR1]
export interface ContextLane {
  readonly id: ContextLaneId;
  readonly purpose: string; // short, human-readable; never a path or secret
  readonly priority: number;
  readonly budget: ContextLaneBudget;
  readonly diagnostics?: ContextLaneDiagnostics | undefined;
}

// ─── Per-lane diagnostics ─────────────────────────────────────────────────── [PR1]
export interface ContextLaneDiagnostics {
  readonly laneId: ContextLaneId;
  readonly estimatedTokens: number;
  readonly includedItems: number;
  readonly excludedItems: number;
  readonly budgetPressure: ContextBudgetPressure;
  readonly compactionReason?: string | undefined; // present only when the lane was compacted
  readonly provenanceCounts?: Readonly<Record<string, number>> | undefined; // path-free counts only
}

// ─── Whole-assembly diagnostics (attach to EvidenceManifest.contextAssembly?) ─ [PR1]
export interface ContextAssemblyDiagnostics {
  readonly schemaVersion: typeof CONTEXT_ENGINEERING_SCHEMA_VERSION;
  readonly profile: ContextProfile;
  readonly totalEstimatedTokens: number;
  readonly budgetPressure: ContextBudgetPressure;
  readonly lanes: readonly ContextLaneDiagnostics[];
  // True when the START-summary / END-next-step layout rule was applied (lost-in-the-middle).
  readonly orderedForRecency: boolean;
}

// ─── Compaction record (defined now, implemented later) ───────────────────── [LATER]
export interface ContextCompactionRecord {
  readonly schemaVersion: typeof CONTEXT_ENGINEERING_SCHEMA_VERSION;
  readonly laneId: ContextLaneId;
  readonly reason: string;
  readonly itemsBefore: number;
  readonly itemsAfter: number;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  // Stable hash of the summarized content so a reviewer can correlate without storing raw text.
  readonly summaryRefHash?: string | undefined;
  // Optional handle to rehydrate the original items (see ContextRehydrationHandle).
  readonly rehydration?: ContextRehydrationHandle | undefined;
}

// ─── Rehydration handle (defined now, implemented later) ──────────────────── [LATER]
// Content-free pointer to the original (pre-compaction) items so a later turn can re-expand
// them. Carries NO raw text, NO absolute path, NO secret — only a stable opaque key and counts.
export interface ContextRehydrationHandle {
  readonly schemaVersion: typeof CONTEXT_ENGINEERING_SCHEMA_VERSION;
  readonly laneId: ContextLaneId;
  readonly handleId: string; // opaque, stable, redaction-free
  readonly itemCount: number;
  readonly approxTokens: number;
}

// ─── Canonical token estimator (the single token currency) ─────────────────── [PR1]
// Deterministic, conservative (slightly over-estimates), total (never throws), offline.
// Counts UTF-8 bytes (TextEncoder with a string.length fallback), divides by a conservative
// divisor, rounds up, and adds a small fixed structural overhead. Empty string => the overhead
// constant (never 0/NaN). Used uniformly by every lane; mixing other ratios is forbidden.
export function estimateTokens(text: string): number;

// Convenience: sum estimateTokens over a set of segments (e.g. messages). Total / never throws.
export function estimateTokensForSegments(segments: readonly string[]): number;

// Derives effectiveInputBudget = maxInputTokens − reservedOutputTokens − safetyMarginTokens,
// clamped to >= 0. Pure. Used to build a ContextProfile from a customer model window override.
export function deriveContextProfile(input: {
  readonly maxInputTokens: number;
  readonly reservedOutputTokens: number;
  readonly safetyMarginTokens: number;
}): ContextProfile;

// ─── Validators (house envelope) ──────────────────────────────────────────── [PR1]
export type ContextValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reasons: readonly string[] };

export function isContextLaneId(value: unknown): value is ContextLaneId;
export function validateContextProfile(value: unknown): ContextValidationResult;
export function validateContextBudget(value: unknown): ContextValidationResult;
export function validateContextAssemblyDiagnostics(value: unknown): ContextValidationResult;
```

### Additive attach points (extensions to existing types)

```ts
// connected-context.ts:301  — extend ContextPackDiagnostics            [PR1]
export interface ContextPackDiagnostics {
  readonly rankedCandidates: readonly RankedCandidateExplanation[];
  readonly contextBudget?: ContextBudget | undefined; // ADDITIVE; absent on legacy packs
}

// bff-wire.ts:603  — extend GroundedAnswerContextPackSummary (path-free) [PR1]
export interface GroundedAnswerContextPackSummary {
  // ...existing fields unchanged...
  readonly contextSummary?: GroundedAnswerContextSummary | undefined; // ADDITIVE, aggregate-only
}
export interface GroundedAnswerContextSummary {
  readonly totalEstimatedTokens: number;
  readonly budgetPressure: ContextBudgetPressure;
  readonly laneCounts: Readonly<Record<ContextLaneId, number>>; // counts only, never paths
}

// evidence.ts:313  — extend EvidenceManifest              [PR1 contextAssembly?, LATER compaction?]
export interface EvidenceManifest {
  // ...existing fields unchanged; NO evidenceSchemaVersion bump...
  readonly contextAssembly?: ContextAssemblyDiagnostics | undefined;  // [PR1]
  readonly compaction?: readonly ContextCompactionRecord[] | undefined; // [LATER]
}

```

### Default lane budget (illustrative, frozen constant in PR1)

A `DEFAULT_CONTEXT_BUDGET` constant pins one `ContextLaneBudget` row per lane against `DEFAULT_CONTEXT_PROFILE`,
encoding the allocation order via `priority` and the non-eviction rule via `eviction: "none"` +
`minReservedTokens > 0` for `system-contract` and `user-task`. Exact token splits are tuned with tests against
the 116k effective budget; the contract is the **shape and order**, not the specific integers, so they can be
re-tuned without a surface change.

## Related

- ADR-0019: modular package architecture and the `boundary.test.ts` no-sibling-import rule.
- ADR-0022: connected-context privacy contract (path-free summaries, counts-only projections).
- ADR-0034 / ADR-0036: hybrid grounding and the shared evidence pool the `repo-evidence` lane fills.
- ADR-0042: keiko-editor package and the `CodingContextBudget` per-purpose byte-cap pattern reused here.
- ADR-0048: evidence artifact confidentiality — the redaction/retention posture the new diagnostics inherit.
- `packages/keiko-contracts/src/connected-context.ts:108,118,282,301`,
  `packages/keiko-contracts/src/bff-wire.ts:603,683`,
  `packages/keiko-contracts/src/evidence.ts:271,291,313,335`,
  `packages/keiko-contracts/src/coding-context.ts:161,167`,
  `packages/keiko-contracts/src/memory-validation.ts:11,45`,
  `packages/keiko-workflows/src/planner/governor.ts:86,101`,
  `packages/keiko-workspace/src/contextPack.ts:53`,
  `packages/keiko-harness/src/context.ts:64`.

## Date

2026-06-23
```
