// Pure readonly contracts for the deterministic context-engineering layer (ADR-0052). No IO,
// no clock, no randomness, no sibling @oscharko-dev/keiko-* import (contracts is a strict leaf).
// estimateTokens is the single canonical token currency; the allocator that consumes
// ContextProfile lives in keiko-workflows. Validators follow the connected-context.ts
// isRecord + predicate envelope and live in the sibling context-engineering-validation.ts to
// keep both files under the 400-LOC budget (mirrors the memory-validation.ts split).

export const CONTEXT_ENGINEERING_SCHEMA_VERSION = "1" as const;

// Provenance string recording which estimator produced a profile's counts. The estimator
// function itself cannot be a JSON-serializable contract field, so the id is carried instead.
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
  // Provenance of the token counts (which estimator produced them). Required.
  readonly tokenEstimatorId: string;
  // Opaque provider/model metadata. Optional, never drives behavior.
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

// ─── Provenance reference (the atomic source pointer) ─────────────────────── [PR2, additive]
// A stable, content-addressable pointer to a single authoritative source. No raw text,
// no absolute paths — only stable IDs plus an optional relative workspace path and line
// range for repo-file items. contentHash is fileContentHash (keiko-workspace) at compaction
// time; a mismatch at rehydration time means the source has changed and the summary MAY be stale.
// REFINEMENT over ADR-0053 D1: the fourth kind is "message" (a conversation message id) rather
// than "intentionally-not-persisted"; the not-persisted case is carried by notPersistedReason on
// any kind. ADR-0053 D1 note updated to match.
export type ContextProvenanceRefKind = "repo-file" | "tool-result" | "evidence-atom" | "message";

export interface ContextProvenanceRef {
  readonly kind: ContextProvenanceRefKind;
  // Stable atom/tool/evidence/message id for de-duplication and correlation. Always present.
  readonly stableId: string;
  // Relative workspace path. Present only when kind === "repo-file". Deny-checked before use.
  readonly scopePath?: string | undefined;
  // Closed line range [startLine, endLine] (1-indexed, inclusive). Present only when a line range
  // was recorded. Prefer line ranges over whole-file rehydration.
  readonly lineRange?: { readonly startLine: number; readonly endLine: number } | undefined;
  // SHA-256 hex of the file content at compaction time. A mismatch at rehydration time signals
  // invalidation. Present only when fileContentHash ran successfully.
  readonly contentHash?: string | undefined;
  // Stable evidence atom id (evidenceAtomStableId output). Present when kind === "evidence-atom".
  readonly evidenceAtomId?: string | undefined;
  // If the original output was intentionally not persisted, a brief human-readable reason.
  readonly notPersistedReason?: string | undefined;
}

// ─── Preserved fact (durable, authoritative) ──────────────────────────────── [PR2, additive]
// Structurally DISTINCT from ContextAssumption — no shared base type. A ContextPreservedFact
// carries statement + (sourceRef and/or inferred) + optional corroborating; it has NO rationale
// and NO confidence, so a ContextAssumption is not assignable here and vice versa. This is the
// load-bearing anti-poisoning rule: structural separation, NOT a flag on a common type.
// REFINEMENT 1 over ADR-0053 D1: sourceRef is OPTIONAL but the validator REQUIRES sourceRef OR
// inferred===true — an unsourced, non-inferred "fact" is rejected. Every factual claim points to
// a source OR is explicitly marked an inference. ADR-0053 D1 note updated to match.
export interface ContextPreservedFact {
  // Short statement of the fact. Human-readable, must not contain PII or secrets.
  readonly statement: string;
  // Primary source reference. Either this OR inferred===true must be present (validator-enforced).
  readonly sourceRef?: ContextProvenanceRef | undefined;
  // Explicit marker that this fact is a model inference, not sourced to a verbatim reference.
  readonly inferred?: boolean | undefined;
  // Additional corroborating references (e.g. a second file evidencing the same fact).
  readonly corroborating?: readonly ContextProvenanceRef[] | undefined;
  // Mutually-exclusive discriminants: a ContextPreservedFact NEVER carries rationale/confidence,
  // so a ContextAssumption (which requires both) is not structurally assignable here. Additive,
  // zero-runtime — valid facts simply never set these. This is the compile-time anti-poisoning gate.
  readonly rationale?: never;
  readonly confidence?: never;
}

// ─── Assumption (uncertain, model-derived) ────────────────────────────────── [PR2, additive]
// Structurally SEPARATE from ContextPreservedFact: required rationale + confidence, no sourceRef,
// no inferred. A compaction builder MAY produce assumptions but the type system forbids placing
// them in the preservedFacts array, so an assumption can never be silently promoted to a fact.
export interface ContextAssumption {
  // Short statement of the uncertain inference. Required.
  readonly statement: string;
  // Why this is an assumption, not a fact (e.g. "inferred from test name, not file content").
  readonly rationale: string;
  // Caller-assigned confidence (deterministic, not model-assigned). Advisory only — any assumption
  // is uncertain regardless of this field.
  readonly confidence: "low" | "medium" | "high";
  // Mutually-exclusive discriminants: an assumption NEVER carries sourceRef/inferred, so a
  // ContextPreservedFact is not structurally assignable here. Additive, zero-runtime.
  readonly sourceRef?: never;
  readonly inferred?: never;
}

// ─── User constraints captured during the compacted turn ──────────────────── [PR2, additive]
export interface ContextUserConstraint {
  readonly statement: string;
  readonly sourceRef?: ContextProvenanceRef | undefined;
}

// ─── Command outcome (summary only, NOT raw stdout) ────────────────────────── [PR2, additive]
export interface ContextCommandOutcome {
  readonly command: string; // short description, not the raw invocation
  readonly exitCode: number;
  readonly summary: string; // byte-bounded digest, <= 200 chars; never raw stdout, never a secret
}

// ─── Invalidation key ──────────────────────────────────────────────────────── [PR2, additive]
// A file-content-hash binding recorded at compaction time. If, at rehydration time, the file's
// current hash differs from this value, the compacted summary derived from that file MUST NOT be
// reused as a current authoritative fact. File-level coarse signal (the per-excerpt content hash
// on ContextRehydrationHandle is the finer signal).
export interface ContextInvalidationKey {
  // Relative workspace path. Must be deny-checked by the caller before any read.
  readonly scopePath: string;
  // SHA-256 hex of the file content at compaction time (fileContentHash). Never null — if hashing
  // fails, omit this entry.
  readonly contentHash: string;
}

// ─── Compaction record (PR1 stub extended additively) ─────────────────────── [PR2, additive]
export interface ContextCompactionRecord {
  // ── PR1 fields (unchanged) ───────────────────────────────
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

  // ── PR2 additions (all optional) ─────────────────────────
  // Caller-injected sequence counter or logical clock value. NEVER Date.now() — the builder
  // receives this from its caller so records stay deterministic.
  readonly orderedAt?: number | undefined;
  // Source spans that were compacted: message ids, tool-result ids, file paths + hashes, evidence ids.
  readonly sourceSpans?: readonly ContextProvenanceRef[] | undefined;
  // Durable facts. Typed ContextPreservedFact[] — cannot contain a ContextAssumption (separate type).
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
  // Item categories explicitly dropped as noise (e.g. "verbose webpack output").
  readonly droppedCategories?: readonly string[] | undefined;
  // Invalidation keys: one entry per source file whose hash was recorded.
  readonly invalidationKeys?: readonly ContextInvalidationKey[] | undefined;
}

// ─── Rehydration handle (PR1 stub extended additively) ────────────────────── [PR2, additive]
// Content-free pointer to the original (pre-compaction) items so a later turn can re-expand them.
// Carries NO raw text, NO absolute path, NO secret — only a stable opaque key, counts, and typed
// dispatch metadata.
export interface ContextRehydrationHandle {
  // ── PR1 fields (unchanged) ───────────────────────────────
  readonly schemaVersion: typeof CONTEXT_ENGINEERING_SCHEMA_VERSION;
  readonly laneId: ContextLaneId;
  readonly handleId: string; // opaque, stable, redaction-free
  readonly itemCount: number;
  readonly approxTokens: number;

  // ── PR2 additions (all optional for backward compat) ─────
  // Explicit kind so the rehydration function dispatches without string parsing.
  readonly kind?: ContextProvenanceRefKind | undefined;
  // For kind === "repo-file": the relative workspace path and optional line range. Deny-checked
  // by the rehydration caller before passing to readExcerpt.
  readonly scopePath?: string | undefined;
  readonly lineRange?: { readonly startLine: number; readonly endLine: number } | undefined;
  // REFINEMENT 2 over ADR-0053 D2: this is the hash of the EXCERPT CONTENT (the exact lines)
  // captured at compaction, NOT the whole file. PR2-W3 rehydration re-hashes the readExcerpt
  // result to detect line-range changes precisely; ContextInvalidationKey.contentHash is the
  // coarser file-level signal. ADR-0053 D2 note updated to match.
  readonly contentHash?: string | undefined;
  // For kind === "evidence-atom": the stable atom id.
  readonly evidenceAtomId?: string | undefined;
  // If the original output was intentionally not persisted, a short reason plus the approved
  // summary that IS the authoritative content (no rehydration path exists).
  readonly notPersistedReason?: string | undefined;
  readonly approvedSummary?: string | undefined;
}

// ─── Canonical token estimator (the single token currency) ─────────────────── [PR1]
// Deterministic, conservative (slightly over-estimates), total (never throws), offline.
//
// bytes-per-token divisor. Deliberately SMALLER than the repo's looser bytes/4 norm so the
// estimate over-counts versus a typical provider tokenization. Over-estimation is the safe
// direction: the allocator fits fewer tokens than the provider would, never more.
const TOKEN_BYTES_PER_TOKEN_DIVISOR = 3.5;
// Small fixed structural overhead per segment, modelling per-message framing. Empty input
// returns exactly this (never 0 / NaN).
const TOKEN_STRUCTURAL_OVERHEAD = 2;

// Uses TextEncoder when available, with a char-length fallback for any legacy
// harness without it. Never throws.
function utf8ByteLength(text: string): number {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(text).length;
  }
  return text.length;
}

export function estimateTokens(text: string): number {
  const bytes = utf8ByteLength(text);
  return TOKEN_STRUCTURAL_OVERHEAD + Math.ceil(bytes / TOKEN_BYTES_PER_TOKEN_DIVISOR);
}

// Sum estimateTokens over a set of segments (e.g. messages). The per-segment overhead models
// per-message framing. Total / never throws on [] or empty segments.
export function estimateTokensForSegments(segments: readonly string[]): number {
  let total = 0;
  for (const segment of segments) {
    total += estimateTokens(segment);
  }
  return total;
}

// Derives effectiveInputBudget = maxInputTokens − reservedOutputTokens − safetyMarginTokens,
// clamped to >= 0. Pure. Used to build a ContextProfile from a customer model window override.
export function deriveContextProfile(input: {
  readonly maxInputTokens: number;
  readonly reservedOutputTokens: number;
  readonly safetyMarginTokens: number;
}): ContextProfile {
  const effective = Math.max(
    0,
    input.maxInputTokens - input.reservedOutputTokens - input.safetyMarginTokens,
  );
  return {
    schemaVersion: CONTEXT_ENGINEERING_SCHEMA_VERSION,
    maxInputTokens: input.maxInputTokens,
    reservedOutputTokens: input.reservedOutputTokens,
    safetyMarginTokens: input.safetyMarginTokens,
    effectiveInputBudget: effective,
    tokenEstimatorId: DEFAULT_TOKEN_ESTIMATOR_ID,
  };
}
