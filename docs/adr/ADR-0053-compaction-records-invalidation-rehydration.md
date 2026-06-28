# ADR-0053: Structured compaction records, invalidation keys, and bounded rehydration

## Status

Proposed

## Version

0.2.0

## Context

ADR-0052 (PR1) defined `ContextCompactionRecord` and `ContextRehydrationHandle` as minimal stubs
in `keiko-contracts/src/context-engineering.ts` (lines 134–158) — structurally present but
deliberately unimplemented, so the additive surface would be stable before any consumer shipped.
The decision log (PR1 Status, `docs/context-engineering/decision-log.md` line 148–153) records PR2
as the implementation milestone and flags two live risks: `rehydrationReadiness` is vacuous in the
CI gate (gated at threshold 0), and `compactionPreservation` is entirely scaffolded.

The agentic harness loop (`keiko-harness executor.ts / loop.ts / planner.ts`) today evicts items
from context via a hard `MAX_CONTEXT_MESSAGES = 24` slice with **zero structured compaction**: no
record of what was dropped, no provenance linking dropped items back to source files, no way to
detect that an evicted item's source has since changed on disk, and no path to re-expand an
evicted excerpt if a later turn needs it. This produces two concrete failure modes:

1. **Silent context poisoning.** An LLM-generated "summary" of a dropped item may be re-used as an
   authoritative fact in subsequent turns. There is no structural distinction between a preserved
   verbatim fact (trustworthy) and a compressed model inference (uncertain). If the source file
   changes after compaction, the stale summary is silently still present.
2. **Unreachable rehydration.** A evicted `repo-evidence` item may carry a `scopePath` + `lineRange`
   that points at exact source, but there is no governed mechanism to re-fetch it. The
   `readExcerpt` primitive in `keiko-workspace/src/repoSearch.ts` is the authoritative deny-gated,
   bounded excerpt reader (lines 79, 441–450) — but no compaction layer calls it.

PR2 must: (a) richly extend the minimal stub types additively; (b) encode the durable-fact vs
assumption separation anti-poisoning rule structurally, not just by convention; (c) define the
`fileContentHash` invalidation helper as a sibling of the existing SHA-256 provenance functions in
`keiko-workspace/src/stableId.ts`; (d) place the compaction builder in `keiko-workflows`
(consuming the allocator's excluded-item output); (e) define the rehydration flow threading
through `readExcerpt`; (f) tighten the CI gate by making `rehydrationReadiness` and
`compactionPreservation` load-bearing.

Constraints carry over from ADR-0052: `exactOptionalPropertyTypes`, `verbatimModuleSyntax`,
`noUncheckedIndexedAccess`; no `as T`, no `!`; complexity ≤ 10, function ≤ 50 LOC, file ≤ 400
LOC; `keiko-contracts` is a strict leaf (no sibling `@oscharko-dev/keiko-*` import;
`boundary.test.ts` must stay green); deterministic (no clock, no randomness in records — all
order metadata is caller-injected); offline, no new npm dependencies.

## Decision

We will implement PR2 as four additive waves:

**W1** — extend the contract types in `keiko-contracts` to carry rich provenance, durable-fact vs
assumption structural separation, and invalidation keys. All new fields are optional on existing
types, so PR1 callers and fixtures are byte-for-byte unaffected.

**W2** — add the `fileContentHash` invalidation helper to `keiko-workspace/src/stableId.ts`,
reusing the local `sha256Hex` (line 37) and the `WorkspaceFs.readFileBytes?` optional port (lines
32–34 of `fs.ts`). Deny-gated by the caller before any byte read (same pattern as `readExcerpt`
at `repoSearch.ts:441–450`).

**W3** — add a pure, no-IO compaction builder module in `keiko-workflows/src/context-budget/`
that consumes the allocator's `excludedItemIds` + optional per-item metadata to produce a
`ContextCompactionRecord[]`; add the governed rehydration function that maps a
`ContextRehydrationHandle` of kind `repo-file` through `readExcerpt` (deny-checked, line-ranged,
bounded). The harness-turn caller injects both the `readExcerpt` dependency and the
caller-supplied `orderedAt` sequence counter.

**W4** — tighten the harness CI gate: promote `rehydrationReadiness` from scaffolded to measured;
add `compactionPreservation` as measured. Both gates must pass at threshold ≥ 0.9 on the corpus
before PR2 is merged.

### D1 — Additive extension of ContextCompactionRecord

> PR2-W1 implementation note (refinements adopted over the illustrative TS below):
> (1) `ContextProvenanceRefKind`'s fourth member is `"message"` (a conversation message id), not
> `"intentionally-not-persisted"`; the not-persisted case is carried by `notPersistedReason` on any
> kind. (2) `ContextPreservedFact.sourceRef` is OPTIONAL and the type gains `inferred?: boolean`; the
> validator requires `sourceRef` OR `inferred===true` (an unsourced, non-inferred fact is rejected) —
> every factual claim points to a source or is explicitly an inference. (3) `ContextUserConstraint`'s
> field is `statement` (not `constraint`). (4) `ContextPreservedFact` and `ContextAssumption` carry
> mutually-exclusive `?: never` discriminants (`rationale`/`confidence` on the fact; `sourceRef`/
> `inferred` on the assumption) so neither is structurally assignable to the other — the anti-poisoning
> separation is compile-time enforced, not merely "no shared base".

The PR1 stub (`context-engineering.ts:134–147`) carries `schemaVersion`, `laneId`, `reason`,
`itemsBefore`, `itemsAfter`, `tokensBefore`, `tokensAfter`, `summaryRefHash?`, and
`rehydration?`. PR2 adds optional companion types and fills `rehydration?` with a richer
`ContextRehydrationHandle`. None of the PR1 fields change type or become required.

The rich record is expressed as a set of companion readonly interfaces (not a single flat 30-field
monster), all in `context-engineering.ts` or its validation companion, with a single
`ContextProvenanceRef` type as the cross-cutting currency for all source-pointing fields.

```ts
// ─── Provenance reference (the atomic source pointer) ─────── [PR2, additive]
// A stable, content-addressable pointer to a single authoritative source. No raw text,
// no absolute paths — only stable IDs plus an optional relative workspace path and line
// range for repo-file items. The contentHash field is the output of fileContentHash
// (keiko-workspace/src/stableId.ts) at the time compaction ran; a hash mismatch
// between compaction time and rehydration time means the source has changed and the
// compacted summary MAY be stale.
export type ContextProvenanceRefKind =
  | "repo-file"       // rehydrate via readExcerpt; scopePath + lineRange required
  | "tool-result"     // raw tool call output; rehydrate from tool-result id only
  | "evidence-atom"   // a keiko evidence atom; rehydrate from evidenceAtomId
  | "intentionally-not-persisted"; // privacy/size: no rehydration path; summary is authoritative

export interface ContextProvenanceRef {
  readonly kind: ContextProvenanceRefKind;
  // Stable atom/tool/evidence id for de-duplication and correlation. Always present.
  readonly stableId: string;
  // Relative workspace path. Present only when kind === "repo-file". Deny-checked before use.
  readonly scopePath?: string | undefined;
  // Closed line range [startLine, endLine] (1-indexed, inclusive). Present only when kind ===
  // "repo-file" AND a line range was recorded. Prefer line ranges over whole-file rehydration.
  readonly lineRange?: { readonly startLine: number; readonly endLine: number } | undefined;
  // SHA-256 hex of the file content at compaction time. Present only when kind === "repo-file"
  // and fileContentHash ran successfully. A mismatch at rehydration time signals invalidation.
  readonly contentHash?: string | undefined;
  // Stable evidence atom id (evidenceAtomStableId output). Present when kind === "evidence-atom".
  readonly evidenceAtomId?: string | undefined;
  // If the original output was intentionally not persisted, a brief human-readable reason.
  readonly notPersistedReason?: string | undefined;
}

// ─── Preserved fact (durable, authoritative) ──────────────── [PR2, additive]
// A fact that is structurally DISTINCT from an assumption. A ContextPreservedFact cannot be
// coerced to or from a ContextAssumption — they are not a discriminated union over a shared
// base. A function parameter typed ContextPreservedFact accepts only facts. This is the
// load-bearing anti-poisoning rule: structural separation, NOT a flag on a common type.
export interface ContextPreservedFact {
  // Short statement of the fact. Human-readable, must not contain PII or secrets (scanForSecrets
  // gate applied at compaction builder before inclusion).
  readonly statement: string;
  // Primary source reference. At least one ref is required for a durable fact.
  readonly sourceRef: ContextProvenanceRef;
  // Additional corroborating references (e.g. second file that evidences the same fact).
  readonly corroborating?: readonly ContextProvenanceRef[] | undefined;
}

// ─── Assumption (uncertain, model-derived) ────────────────── [PR2, additive]
// An uncertain inference the model produced during compaction. Structurally SEPARATE from
// ContextPreservedFact so it cannot be silently promoted to a trusted fact. Every assumption
// must be explicitly re-evaluated against current source before being treated as ground truth.
// The anti-poisoning rule: a compaction builder MAY produce assumptions but MUST NOT place
// them in the preservedFacts array (the type system enforces this at compile time).
export interface ContextAssumption {
  // Short statement of the uncertain inference. Required.
  readonly statement: string;
  // Why this is an assumption, not a fact (e.g. "inferred from test name, not file content").
  readonly rationale: string;
  // Confidence level (caller-assigned, not model-assigned — keeps this deterministic).
  // "low" | "medium" | "high" but semantics are advisory only; the key invariant is that
  // ANY assumption is uncertain regardless of this field.
  readonly confidence: "low" | "medium" | "high";
}

// ─── User constraints captured during the compacted turn ──── [PR2, additive]
export interface ContextUserConstraint {
  readonly constraint: string;
  readonly sourceRef?: ContextProvenanceRef | undefined;
}

// ─── The rich compaction record ───────────────────────────── [PR2, additive extension]
// Extends the PR1 stub additively. All new fields are optional; a PR1-minimal record
// (with only the seven required fields) remains valid under the expanded schema.
export interface ContextCompactionRecord {
  // ── PR1 fields (unchanged) ───────────────────────────────
  readonly schemaVersion: typeof CONTEXT_ENGINEERING_SCHEMA_VERSION;
  readonly laneId: ContextLaneId;
  readonly reason: string;
  readonly itemsBefore: number;
  readonly itemsAfter: number;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  readonly summaryRefHash?: string | undefined;
  readonly rehydration?: ContextRehydrationHandle | undefined;

  // ── PR2 additions (all optional) ─────────────────────────
  // Caller-injected sequence counter or logical clock value. NOT a wall-clock read.
  // Deterministic: the compaction builder receives this from its caller.
  readonly orderedAt?: number | undefined;
  // Source spans that were compacted: message ids, tool-result ids, file paths + hashes, evidence ids.
  readonly sourceSpans?: readonly ContextProvenanceRef[] | undefined;
  // Durable facts extracted from the compacted content. Typed ContextPreservedFact[] — cannot
  // accidentally contain ContextAssumption (separate type, not a discriminated union).
  readonly preservedFacts?: readonly ContextPreservedFact[] | undefined;
  // Uncertain model-derived inferences. Structurally separate from preservedFacts.
  readonly assumptions?: readonly ContextAssumption[] | undefined;
  // User instructions or constraints active during the compacted turn.
  readonly userConstraints?: readonly ContextUserConstraint[] | undefined;
  // Decisions recorded during the compacted turn (e.g. chosen approach, rejected alternative).
  readonly decisions?: readonly string[] | undefined;
  // Questions that remain open at compaction time. These are NOT facts.
  readonly openQuestions?: readonly string[] | undefined;
  // File paths (relative, deny-checked before any read) that were INSPECTED but not changed.
  readonly filesInspected?: readonly string[] | undefined;
  // File paths (relative) that were CHANGED during the compacted turn.
  readonly filesChanged?: readonly string[] | undefined;
  // Commands that ran during the compacted turn, with short outcome summaries (NOT raw stdout).
  readonly commandOutcomes?: readonly ContextCommandOutcome[] | undefined;
  // Failing tests or errors at the end of the compacted turn.
  readonly failingTests?: readonly string[] | undefined;
  // Item categories that were explicitly dropped as noise (e.g. "verbose webpack output").
  readonly droppedCategories?: readonly string[] | undefined;
  // Invalidation keys: one entry per source file whose hash was recorded. If any hash mismatches
  // at rehydration time, this record's repo-derived content is considered potentially stale.
  readonly invalidationKeys?: readonly ContextInvalidationKey[] | undefined;
}

// ─── Command outcome (summary only, NOT raw stdout) ────────── [PR2, additive]
export interface ContextCommandOutcome {
  readonly command: string; // short description, not the raw invocation
  readonly exitCode: number;
  readonly summary: string; // ≤ 200 chars; never raw stdout, never a secret
}

// ─── Invalidation key ─────────────────────────────────────── [PR2, additive]
// A file-content-hash binding recorded at compaction time. If, at rehydration time,
// the file's current hash differs from this value, the compacted summary derived from
// that file MUST NOT be reused as a current authoritative fact.
export interface ContextInvalidationKey {
  // Relative workspace path. Must be deny-checked by the caller before any read.
  readonly scopePath: string;
  // SHA-256 hex of the file content at compaction time. Produced by fileContentHash
  // (keiko-workspace/src/stableId.ts). Never null — if hashing fails, omit this entry.
  readonly contentHash: string;
}
```

### D2 — Refined ContextRehydrationHandle

> PR2-W1 implementation note: `ContextRehydrationHandle.contentHash` is the hash of the EXCERPT
> CONTENT (the exact captured lines), recorded at compaction time, so PR2-W3 rehydration can
> re-hash the `readExcerpt` result and detect line-range changes precisely. The file-level
> `ContextInvalidationKey.contentHash` remains the coarser, whole-file change signal.

The PR1 stub carries only `schemaVersion`, `laneId`, `handleId`, `itemCount`, and `approxTokens`.
PR2 replaces the opaque `handleId` interpretation with explicit `kind`-discriminated fields so the
compaction builder and the rehydration function both operate on typed contracts rather than
string interpretation. The PR1 shape is extended, not replaced.

```ts
// ─── Rehydration handle (PR2 extension of PR1 stub) ──────── [PR2, additive]
// A content-free pointer that the rehydration function resolves on demand via readExcerpt
// (repo-file), a tool-result registry (tool-result), or the evidence ledger (evidence-atom).
// If the original output was intentionally not persisted, the handle records that fact and
// carries only the approved summary. Carries NO raw text, NO absolute path, NO secret.
export interface ContextRehydrationHandle {
  // ── PR1 fields (unchanged) ───────────────────────────────
  readonly schemaVersion: typeof CONTEXT_ENGINEERING_SCHEMA_VERSION;
  readonly laneId: ContextLaneId;
  readonly handleId: string;
  readonly itemCount: number;
  readonly approxTokens: number;

  // ── PR2 additions (all optional for backward compat) ─────
  // Explicit kind so the rehydration function can dispatch without string parsing.
  readonly kind?: ContextProvenanceRefKind | undefined;
  // For kind === "repo-file": the relative workspace path and optional line range.
  // Deny-checked by the rehydration caller before passing to readExcerpt.
  readonly scopePath?: string | undefined;
  readonly lineRange?: { readonly startLine: number; readonly endLine: number } | undefined;
  // Content hash recorded at compaction time (output of fileContentHash).
  readonly contentHash?: string | undefined;
  // For kind === "evidence-atom": the stable atom id.
  readonly evidenceAtomId?: string | undefined;
  // For kind === "intentionally-not-persisted": a short human-readable reason plus an
  // approved summary that IS the authoritative content (no rehydration path exists).
  readonly notPersistedReason?: string | undefined;
  readonly approvedSummary?: string | undefined;
}
```

### D3 — fileContentHash helper in keiko-workspace/src/stableId.ts

A new exported function placed alongside the existing `sha256Hex` (line 37), `evidenceAtomStableId`
(line 41), and `connectedContextPackStableId` (line 56). It reuses `sha256Hex` internally (no new
crypto import; the module already imports `createHash` from `node:crypto`). It reads via
`WorkspaceFs.readFileBytes?` (optional port, `fs.ts:32–34`) — if the port is absent (legacy test
fakes), the function returns `undefined` rather than throwing.

The caller is responsible for deny-checking `scopePath` before calling this function. The function
itself takes an absolute path (resolved by the caller) and a `WorkspaceFs` instance. It does NOT
call `isDenied` itself — that gate belongs at the boundary where the caller knows whether the
relative path has already been cleared (same pattern as `readExcerpt` at `repoSearch.ts:441`).

```ts
// Signature only — implementation is the implementor's job.
// packages/keiko-workspace/src/stableId.ts (additive export, placed after connectedContextPackStableId)

// Hashes the first MAX_HASH_FILE_BYTES of a workspace file for use as a compaction invalidation
// key. Returns undefined when readFileBytes is unavailable (legacy test fakes) or the read fails
// with an IO error. The caller MUST deny-check the relative path before calling this function.
// NOT a clock read — deterministic given the same file bytes.
export async function fileContentHash(
  fs: WorkspaceFs,
  absolutePath: string,
): Promise<string | undefined>;
```

The byte cap for hashing is `MAX_HASH_FILE_BYTES = 131_072` (128 KiB). For files larger than this,
only the first 128 KiB is hashed — the hash is a change-detection signal, not a cryptographic
content guarantee. This matches the `excerptBytesMax: 131_072` default in the exploration budget
(`connected-context.ts:122`), avoiding a new constant for what is essentially the same "excerpt
budget" concept.

`WorkspaceFs.mtimeMs` (`fs.ts:15`) is a valid fast-path staleness signal when `readFileBytes?` is
absent, but it is NOT used as the invalidation hash (mtime is not content-addressable). If mtime
is the only available signal, the compaction builder omits the invalidation key rather than
recording a non-hash value.

### D4 — Compaction builder in keiko-workflows

A new pure, no-IO module `keiko-workflows/src/context-budget/compaction.ts` (≤ 400 LOC; split
into `compaction-builder.ts` / `compaction-validation.ts` if needed). It consumes:

- The `AllocateContextResult` from the allocator (`allocator.ts`) — specifically, the
  `excludedItemIds` arrays from each `AllocatedContextLane`.
- Optional per-item metadata: `ContextProvenanceRef` keyed by item id (caller-supplied; the
  allocator does not carry full metadata for excluded items).
- A caller-supplied `orderedAt: number` (a sequence counter or injected logical clock — never
  `Date.now()` in the builder itself).
- A `scanForSecrets` gate from `keiko-memory-capture` (applied to every `statement` field in
  `preservedFacts` and `assumptions` before inclusion — defense against secret persistence in
  compaction bodies).

The builder returns `readonly ContextCompactionRecord[]` — one record per lane that had
`excludedItemIds.length > 0`. It is a pure function: no IO, no clock, no randomness.

**The builder must never place a `ContextAssumption` in the `preservedFacts` array.** This is
enforced at the type level: `preservedFacts` is typed `readonly ContextPreservedFact[]`, and
`ContextAssumption` is a distinct interface with no shared structural signature (it carries
`rationale` and `confidence`, which `ContextPreservedFact` does not have). TypeScript's
structural type system enforces this without any runtime check.

### D5 — Rehydration flow

A new exported function `rehydrateHandle` in `keiko-workflows/src/context-budget/rehydration.ts`
(or co-located with the compaction builder). It takes a `ContextRehydrationHandle`, a `SearchScope`
(from `keiko-workspace`), a `WorkspaceFs` instance, and a `maxBytes` cap. It dispatches on
`handle.kind`:

- `"repo-file"`: asserts `handle.scopePath` is present, calls `isDenied` from `ignore.ts` (deny
  gate FIRST, before any byte read — same as `repoSearch.ts:445`), then calls `readExcerpt` from
  `keiko-workspace/src/repoSearch.ts`. Prefer line range (`handle.lineRange`) over full-file when
  present. Returns the excerpt content and the current `fileContentHash` so the caller can
  compare against `handle.contentHash` to detect invalidation.
- `"tool-result"` / `"evidence-atom"`: returns a typed result indicating the item must be
  re-fetched from the tool-result registry or evidence ledger (out of scope for PR2; the
  function returns a `RehydrationResult` variant that signals "unresolvable in PR2").
- `"intentionally-not-persisted"`: returns the `handle.approvedSummary` immediately with a flag
  that no rehydration was performed.

Invalidation check: if `handle.contentHash` is present and `handle.kind === "repo-file"`, the
function hashes the current file content via `fileContentHash` and compares. If they differ, the
result carries `invalidated: true` — the caller MUST NOT treat the rehydrated content as a
current authoritative fact without re-verifying.

**Rehydration is always bounded**: `maxBytes` is capped at `MAX_EXCERPT_FILE_BYTES = 2_097_152`
(the constant at `repoSearch.ts:79`); the rehydration function enforces this cap independently of
whatever the caller passes, so a caller passing `Infinity` or an oversized value cannot bypass it.

### D6 — Compaction record I/O: in-memory only (no workspace file)

`.keiko` and `.claude` are deny-listed in `ignore.ts` (`DEFAULT_DENY_PATTERNS` lines 87–90) and
therefore deny-checked by `readExcerpt`. Compaction records therefore CANNOT be stored as workspace
files and re-read via `readWorkspaceFile` or `readExcerpt`.

PR2 keeps records **in-memory only**: the compaction builder returns records as a plain
`readonly ContextCompactionRecord[]` value; callers hold them in the harness turn state. They are
NOT persisted in PR2. Evidence persistence of compaction records (as a redacted, audited entry in
`EvidenceManifest.compaction?`) is deferred to PR5, which will route them through the
`applyRetention` + `redact` + `writeSideFile` stack (ADR-0048 confidentiality posture). This is
the "calendar → evidence ledger" path, not a workspace file write.

Per-turn compaction is NOT routed through `keiko-memory-consolidation` (confirmed boundary in
`decision-log.md` line 91–93: that package is long-term knowledge dedup, not per-turn context
shaping).

### D7 — Idempotency

A compaction record is idempotent in the sense that running the builder twice on the same
`AllocateContextResult` + same metadata inputs produces the same record (referential equality of
the JSON serialization). This follows from:
(a) deterministic allocator output (ADR-0052 gate 5),
(b) no clock in the builder (orderedAt is caller-injected),
(c) sha256Hex is deterministic on the same bytes.

Idempotency of the REHYDRATION is weaker: the file content may change between the first and a
subsequent rehydration call. That is the `invalidated` flag's job, not an idempotency violation.

### D8 — Where each type/helper lives

| Type / Helper | Package | Justification |
|---|---|---|
| `ContextProvenanceRef`, `ContextPreservedFact`, `ContextAssumption`, `ContextUserConstraint`, `ContextCommandOutcome`, `ContextInvalidationKey`, `ContextProvenanceRefKind` (new types) | `keiko-contracts/src/context-engineering.ts` (or its validation split `context-engineering-validation.ts`) | Contracts is the strict leaf that owns all public readonly interfaces. No sibling import needed — these types reference only primitives and `ContextLaneId` already defined there. `boundary.test.ts` stays green. |
| `ContextCompactionRecord` (PR1 stub extended additively), `ContextRehydrationHandle` (PR1 stub extended additively) | `keiko-contracts/src/context-engineering.ts` | Same file, additive fields only. No breaking change. |
| Validators for new types | `keiko-contracts/src/context-engineering-validation.ts` | Already the validation split for this module (ADR-0052 D4 precedent). |
| `fileContentHash` | `keiko-workspace/src/stableId.ts` | Reuses local `sha256Hex` (line 37) and `WorkspaceFs` (already imported via `fs.ts`). The function is a pure provenance primitive, co-located with `evidenceAtomStableId` and `connectedContextPackStableId`. No new package edge. |
| `buildCompactionRecords` (builder) | `keiko-workflows/src/context-budget/compaction.ts` | Consumes `AllocateContextResult` (same package) and `ContextCompactionRecord` (keiko-contracts). Correct tier: workflows may import contracts and workspace (ADR-0019). No new package edge. |
| `rehydrateHandle` | `keiko-workflows/src/context-budget/rehydration.ts` | Depends on `readExcerpt` (keiko-workspace) and `ContextRehydrationHandle` (keiko-contracts). Correct tier. No new package edge. |
| `evaluateCompactionPreservation` (harness gate, PR4) | `scripts/check-context-quality.mjs` | Already the gate harness; compaction preservation joins `rehydrationReadiness` as a measured gate. |

### D9 — Measurable acceptance gates (what makes PR2 done)

1. **No new required fields on PR1 stub types.** A fixture created from the PR1 minimal
   `ContextCompactionRecord` (seven required fields only) must pass `validateContextCompactionRecord`
   and round-trip through `JSON.parse(JSON.stringify(...))` unchanged. Pinned by a test.
2. **Structural anti-poisoning.** A test asserts that TypeScript rejects (at compile time, via
   `expect-type` or `ts-expect-error`) assigning a `ContextAssumption` to `ContextPreservedFact[]`.
   A runtime assertion confirms the builder never places an assumption in `preservedFacts`.
3. **fileContentHash determinism.** Same bytes → same hash on successive calls. Empty file → a
   defined non-empty hex string. File larger than `MAX_HASH_FILE_BYTES` → hash of the first
   `MAX_HASH_FILE_BYTES` bytes only. `readFileBytes?` absent → returns `undefined` (no throw).
4. **rehydration deny-gate.** A test asserts that calling `rehydrateHandle` with a
   `ContextRehydrationHandle` whose `scopePath` is in the deny list (e.g. `.keiko/state.json`)
   throws or returns an error result — it never calls `readExcerpt` on a denied path.
5. **Invalidation detection.** A test asserts that if `handle.contentHash` differs from the
   current file hash at rehydration time, the result carries `invalidated: true`.
6. **rehydrationReadiness gate tightened.** `scripts/check-context-quality.mjs`
   `evaluateRehydrationReadiness` moves from scaffolded (`deferredUntil: "PR2"`, threshold 0)
   to measured with threshold ≥ 0.9 in `check-context-quality.budget.json`. The corpus must
   contain at least two excluded `repo-evidence` items with `scopePath + lineRange` populated.
7. **compactionPreservation gate added.** A new `evaluateCompactionPreservation` function in the
   harness verifies that for every excluded item with a `ContextProvenanceRef` of kind `"repo-file"`,
   the compaction record carries a corresponding `ContextInvalidationKey`. Gate threshold ≥ 0.8.
8. **boundary.test.ts green.** No new sibling `@oscharko-dev/keiko-*` import in `keiko-contracts`.
9. **Strict-TS clean.** All new files compile under the package `tsconfig.json` with no `as T`,
   no `!`, no ESLint suppressions, files ≤ 400 LOC, cyclomatic complexity ≤ 10.
10. **Backward compat.** The PR1 `AllocateContextResult` fixture from the PR1 acceptance test
    continues to pass without modification.

### D10 — What PR2 does NOT do

- **Evidence persistence of compaction records** — deferred to PR5 (`persistContextAssemblyEvidence`,
  redacted audit, `EvidenceManifest.compaction?` wiring).
- **Orchestrator + harness integration** — threading the compaction builder into the live
  harness loop and splicing history compaction is PR4.
- **Tool-observation shaping** — `ContextRehydrationHandle` of kind `"tool-result"` is defined
  but not resolved in PR2. Resolution comes in PR3.
- **UI disclosure** — `ContextStatusPanel` grounding disclosure is PR6.
- **M5 semantic reranking / embeddings** — out of scope for this milestone.

## Consequences

### Positive

- Durable facts and model-derived assumptions are structurally separated at the type level.
  The TypeScript compiler prevents an assumption from being silently promoted to a trusted fact —
  no runtime flag or convention to forget.
- The `ContextInvalidationKey` + `fileContentHash` mechanism makes stale-context detection
  explicit: any caller that holds a `ContextCompactionRecord` and sees a source file change can
  invalidate the record before the next turn's allocator run.
- `readExcerpt` (deny-gated, bounded, line-ranged) is the single rehydration primitive for
  `repo-file` handles. No new excerpt reader is introduced. Existing security gates
  (`isDenied` at `repoSearch.ts:445`, `MAX_EXCERPT_FILE_BYTES` at `repoSearch.ts:79`,
  `containedRealPathInfo` at `repoSearch.ts:436`) fire unconditionally on every rehydration call.
- The compaction builder is pure and no-IO, like the allocator it wraps. Fully unit-testable
  with a fake `WorkspaceFs`.
- PR2 makes two previously scaffolded CI metrics (`rehydrationReadiness`,
  `compactionPreservation`) load-bearing, closing the "silent deferred metric" gap noted in
  `decision-log.md` line 160–163.

### Negative

- The rich `ContextCompactionRecord` has many optional fields. A minimal implementation that
  populates none of them satisfies the type but provides no diagnostic value. The acceptance
  gates (D9-7) require the corpus to exercise `ContextInvalidationKey` population; without that,
  the compaction builder could remain a no-op.
- `fileContentHash` hashes only the first 128 KiB of large files. A change in the tail of a
  large file produces a false-negative (no invalidation detected). Accepted: the purpose is
  change detection on the excerpt range, not whole-file content-addressing.
- `rehydrateHandle` for `"tool-result"` and `"evidence-atom"` kinds returns an unresolved result
  in PR2. Code that receives these handles in PR2 must have a graceful "not yet resolvable" path.
  This is an honest deferral, but it means the handle type promises more than PR2 delivers.

### Neutral

- Compaction records are in-memory only in PR2. No persistence, no serialization contract to
  honour yet. PR5 adds persistence; PR2 and PR5 can be developed in parallel since the
  in-memory shape is the serialization shape (plain JSON-compatible interfaces).
- The `ContextProvenanceRefKind` discriminant is a string union, not a tagged-enum pattern.
  This is consistent with the rest of the contracts vocabulary (`ContextLaneId`,
  `ContextEvictionPolicy`) and satisfies `noUncheckedIndexedAccess` without narrowing tricks.

## Alternatives Considered

### Alternative 1: Extend ContextCompactionRecord as a single flat type with a boolean `isAssumption` flag

The simplest approach is to add `isAssumption?: boolean` to a shared fact type, letting facts
and assumptions share one array.

- **Pros**: one array, one type, minimal surface change.
- **Cons**: the anti-poisoning rule depends on a runtime flag that any consumer can ignore.
  A caller that iterates over "preserved facts" and doesn't check the flag silently treats
  assumptions as authoritative. The milestone requirement explicitly states that assumptions
  "MUST NEVER be promoted to trusted facts." A boolean flag is convention, not enforcement.
- **Why rejected**: structural separation is the load-bearing guarantee. Two distinct types
  (`ContextPreservedFact` and `ContextAssumption`) make the compiler reject a misassignment.
  The cost is two type definitions instead of one; the benefit is a compile-time invariant
  rather than a runtime-checked convention.

### Alternative 2: Store compaction records as workspace files under .keiko/compaction/

Writing records as JSON to a `.keiko/compaction/` directory would make them durable across
process restarts and accessible to a future `keiko repair` audit.

- **Pros**: persistence without PR5; survives harness crash; inspectable with a text editor.
- **Cons**: `.keiko` is deny-listed in `ignore.ts` (line 87). Any attempt to re-read these
  files via `readExcerpt` or `readWorkspaceFile` will be silently blocked by `isDenied`.
  A compaction record that can be written but not re-read via the governed path is either
  useless (for rehydration) or requires a second, ungoverned read path (a security regression).
  Additionally, PR5's evidence-ledger persistence route (through `applyRetention`, `redact`,
  `writeSideFile`) is the established pattern for durable artifacts (ADR-0048); duplicating it
  with raw `.keiko/` writes bypasses the retention and redaction stack.
- **Why rejected**: the deny-list constraint makes `.keiko/` workspace files unreadable through
  the governed path. PR5's evidence-ledger route is the correct persistence mechanism. PR2
  keeps records in-memory only, matching the allocator's own statefulness model.

### Alternative 3: Route rehydration through a new keiko-compaction package

A dedicated `keiko-compaction` package (sibling of `keiko-workspace` and `keiko-workflows`)
would own both the builder and the rehydration function, reducing the `keiko-workflows` module's
responsibility.

- **Pros**: single-responsibility package; clean boundary; no entanglement with the allocator.
- **Cons**: the builder MUST consume the allocator's `AllocateContextResult` (same package as
  the allocator). A new package would either need to import `keiko-workflows` (creating a
  circular `keiko-compaction → keiko-workflows` if the allocator needs to import compaction
  types) or would require the allocator to be split. There are not yet three independent
  compaction-related modules (the ADR-0052 "three usages before extraction" rule applies). A
  new package also requires `package.json`, `tsconfig.json`, boundary gate updates, and a new
  `npm ci` dependency chain — non-trivial buy-in.
- **Why rejected**: `keiko-workflows` already owns the allocator. The compaction builder is a
  thin pure wrapper over the allocator output. Adding it to `keiko-workflows` requires zero new
  package-graph edges and no new configuration files. If compaction grows to three independent
  sub-modules, extraction to a dedicated package is the right move at that point.

### Alternative 4: Use mtimeMs as the invalidation signal instead of a content hash

`WorkspaceFs.stat()` returns `mtimeMs?` (optional, `fs.ts:15`). Using mtime as the change
signal avoids the `readFileBytes?` optionality issue.

- **Pros**: synchronous, always available when `stat` is available, no read of file bytes.
- **Cons**: mtime is not content-addressable. A `git checkout`, a `touch`, or a no-op write
  changes mtime without changing content. A file restored to a previous version gets a newer
  mtime and is incorrectly flagged as changed. Conversely, a file copied with preserved
  timestamps may not be flagged at all. The invalidation key's job is to detect that the
  semantic content the summary was derived from has changed; only a content hash can do that.
- **Why rejected**: content hash is the correct primitive for content-addressable change
  detection. The `fileContentHash` helper handles the `readFileBytes?` optionality by returning
  `undefined` when the port is absent, and callers omit the invalidation key in that case rather
  than falling back to mtime. An honest "no invalidation key" is safer than a wrong one.

## Related

- ADR-0052: the PR1 foundation. Defines the minimal `ContextCompactionRecord` / `ContextRehydrationHandle`
  stubs this ADR extends; the `estimateTokens` currency; the eight-lane taxonomy; the allocator in
  `keiko-workflows`.
- ADR-0019: modular package architecture and the `boundary.test.ts` no-sibling-import rule. D8
  above explicitly maps each new type to its package with boundary justification.
- ADR-0022: connected-context privacy contract — path-free summaries, counts-only projections to
  the browser. The `ContextCompactionRecord` carries relative paths in `filesInspected`/
  `filesChanged` and `ContextProvenanceRef.scopePath`; these are NOT surfaced to the browser and
  are redacted at the PR5 evidence persistence step.
- ADR-0048: evidence artifact confidentiality — the redaction/retention posture that PR5 will
  apply to persisted compaction records. `scanForSecrets`/`applyPolicy` (keiko-memory-capture)
  are gate references; `redact`/`deepRedactStrings` (keiko-security) are the PR5 persistence
  path. PR2 applies `scanForSecrets` in the builder as an in-memory defense-in-depth.
- `packages/keiko-workspace/src/repoSearch.ts:79` — `MAX_EXCERPT_FILE_BYTES = 2_097_152` cap.
- `packages/keiko-workspace/src/repoSearch.ts:441–450` — `isDenied` + `containedRealPathInfo`
  gates fire before any byte read in `readExcerpt`.
- `packages/keiko-workspace/src/stableId.ts:37` — `sha256Hex` reused by `fileContentHash`.
- `packages/keiko-workspace/src/fs.ts:32–34` — `readFileBytes?` optional port.
- `packages/keiko-workflows/src/context-budget/allocator.ts:39–47` — `AllocatedContextLane`
  (carries `excludedItemIds`) which is the compaction builder's primary input.
- `scripts/check-context-quality.mjs:226–247` — `evaluateRehydrationReadiness` (scaffolded in
  PR1, promoted to measured in PR2).

## Date

2026-06-23
