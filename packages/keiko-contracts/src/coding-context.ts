// Governed coding-context retrieval contracts (Issue #1211, ADR-0042 D6). The server-side retrieval
// service assembles bounded, redacted coding context for editor-originated requests (completion,
// inline ghost text, test generation, explanation, diagnostics) by reusing the existing retrieval
// substrate — repository search, Local Knowledge query-only retrieval, and memory retrieval — not a
// new editor-only collector. Two pack shapes are defined and the distinction is load-bearing:
//
//   - CodingContextPack: SERVER-INTERNAL, content-bearing (redacted excerpts). Fed to a governed
//     model or the harness in-process. It is never serialized to the browser and never persisted
//     raw to evidence.
//   - CodingContextWirePack: content-free. The BFF response to the host and the evidence/audit
//     projection. It carries only citations (provenance pointers + accounting), never excerpt text,
//     raw queries, prompts, workspace roots, or secrets.
//
// Retrieved repository text, Local Knowledge chunks, and memory are UNTRUSTED model input (OWASP
// LLM08:2025 vector and embedding weaknesses; indirect LLM01:2025 prompt injection). Every citation
// and excerpt carries a source trust tier so a consumer can audit cross-tier/cross-tenant flow, and
// no retrieved content may grant tool authority or a model-privileged outcome — the consuming task
// (e.g. generate-unit-tests with allowsTools=false) and the explicit-acceptance gate remain the only
// authorities. The source-kind vocabulary mirrors the browser-side EditorContextSourceKind owned by
// @oscharko-dev/keiko-editor so a host maps these server citations onto the editor context port 1:1
// without a translation table; this package never imports the editor package (wrong tier direction).

export const CODING_CONTEXT_SCHEMA_VERSION = "1" as const;

// ─── Purpose ────────────────────────────────────────────────────────────────────
// Drives provider eligibility and the latency/cost budget. `inline` (as-you-type ghost text) and
// `diagnostic` are keystroke-sensitive and forbid embedding-cost providers (see CODING_CONTEXT_BUDGETS).
export type CodingContextPurpose =
  "inline" | "completion" | "test-generation" | "explain" | "diagnostic";

export const CODING_CONTEXT_PURPOSES: readonly CodingContextPurpose[] = [
  "inline",
  "completion",
  "test-generation",
  "explain",
  "diagnostic",
] as const;

// ─── Source kind + trust tier ─────────────────────────────────────────────────────
export type CodingContextSourceKind =
  | "repo-search"
  | "connected-context"
  | "local-knowledge"
  | "memory"
  | "quality-intelligence"
  | "workflow-context"
  | "files-focus"
  | "editor-state";

export const CODING_CONTEXT_SOURCE_KINDS: readonly CodingContextSourceKind[] = [
  "repo-search",
  "connected-context",
  "local-knowledge",
  "memory",
  "quality-intelligence",
  "workflow-context",
  "files-focus",
  "editor-state",
] as const;

// OWASP LLM08/LLM01 trust tier. The tier is a provenance label for audit and consumer policy; it is
// never an authority grant. No tier permits a model-privileged outcome.
export type CodingContextSourceTier =
  "first-party-workspace" | "indexed-knowledge" | "retained-memory" | "derived-evidence";

export const CODING_CONTEXT_SOURCE_TIERS: readonly CodingContextSourceTier[] = [
  "first-party-workspace",
  "indexed-knowledge",
  "retained-memory",
  "derived-evidence",
] as const;

// Fixed source-kind -> tier mapping. Centralised so every provider tags identically and a test can
// assert no source-kind is left untiered.
export const CODING_CONTEXT_SOURCE_TIER_BY_KIND: Readonly<
  Record<CodingContextSourceKind, CodingContextSourceTier>
> = {
  "repo-search": "first-party-workspace",
  "files-focus": "first-party-workspace",
  "editor-state": "first-party-workspace",
  "connected-context": "first-party-workspace",
  "local-knowledge": "indexed-knowledge",
  memory: "retained-memory",
  "quality-intelligence": "derived-evidence",
  "workflow-context": "derived-evidence",
} as const;

// ─── Omission ─────────────────────────────────────────────────────────────────────
export type CodingContextOmissionReason =
  "unavailable" | "not-ready" | "denied" | "too-expensive" | "out-of-budget";

export const CODING_CONTEXT_OMISSION_REASONS: readonly CodingContextOmissionReason[] = [
  "unavailable",
  "not-ready",
  "denied",
  "too-expensive",
  "out-of-budget",
] as const;

export interface CodingContextOmission {
  readonly sourceKind: CodingContextSourceKind;
  readonly reason: CodingContextOmissionReason;
}

// ─── Citation (content-free) + excerpt (content-bearing) ────────────────────────────
// A content-free provenance pointer. It must never carry excerpt text, a raw query, a prompt, an
// absolute workspace root, or a secret. `citationRef` is a safe, redacted label (a path basename or
// a chunk pointer), never an absolute path or credential.
export interface CodingContextCitation {
  readonly sourceKind: CodingContextSourceKind;
  readonly sourceTier: CodingContextSourceTier;
  readonly id: string;
  readonly score: number;
  readonly rank: number;
  readonly citationRef: string | undefined;
  readonly byteCount: number;
  readonly truncated: boolean;
}

// A content-bearing excerpt. SERVER-INTERNAL ONLY: the `text` is redacted and format-char-stripped
// and byte-bounded, but it is still source content and must not reach the browser or a raw evidence
// record. Only its `citation` is wire- and audit-safe.
export interface CodingContextExcerpt {
  readonly citation: CodingContextCitation;
  readonly text: string;
}

export interface CodingContextPack {
  readonly schemaVersion: typeof CODING_CONTEXT_SCHEMA_VERSION;
  readonly purpose: CodingContextPurpose;
  readonly excerpts: readonly CodingContextExcerpt[];
  readonly usedBytes: number;
  readonly budgetBytes: number;
  readonly droppedForBudget: number;
  readonly omissions: readonly CodingContextOmission[];
}

export interface CodingContextWirePack {
  readonly schemaVersion: typeof CODING_CONTEXT_SCHEMA_VERSION;
  readonly purpose: CodingContextPurpose;
  readonly entries: readonly CodingContextCitation[];
  readonly usedBytes: number;
  readonly budgetBytes: number;
  readonly droppedForBudget: number;
  readonly omissions: readonly CodingContextOmission[];
}

// ─── Per-purpose budget + provider eligibility ──────────────────────────────────────
// The keystroke-sensitive purposes (inline, diagnostic) forbid embedding-cost providers (Local
// Knowledge, memory) so as-you-type ghost text is never blocked on an embedding round-trip
// (ADR-0042 D5/D6; Issue #1211 AC: Local Knowledge and memory are excluded from per-keystroke
// inline completion).
export interface CodingContextBudget {
  readonly budgetBytes: number;
  readonly maxBytesPerSource: number;
  readonly allowEmbeddingProviders: boolean;
}

export const CODING_CONTEXT_BUDGETS: Readonly<Record<CodingContextPurpose, CodingContextBudget>> = {
  inline: { budgetBytes: 8_192, maxBytesPerSource: 2_048, allowEmbeddingProviders: false },
  completion: { budgetBytes: 32_768, maxBytesPerSource: 8_192, allowEmbeddingProviders: true },
  "test-generation": {
    budgetBytes: 65_536,
    maxBytesPerSource: 16_384,
    allowEmbeddingProviders: true,
  },
  explain: { budgetBytes: 49_152, maxBytesPerSource: 12_288, allowEmbeddingProviders: true },
  diagnostic: { budgetBytes: 16_384, maxBytesPerSource: 4_096, allowEmbeddingProviders: false },
} as const;

// ─── Request ────────────────────────────────────────────────────────────────────
export type CodingContextScopeKind = "file" | "symbol" | "selection" | "changed-set";

// Editor-originated intent + coordinates. The workspace root is resolved and contained server-side
// (it is never accepted from the browser as an absolute path); the request carries workspace-relative
// coordinates only. Memory-retrieval scopes are NOT client-controlled: the service derives them
// server-side from the contained workspace root (workspace/project/operator/global), so a browser
// cannot widen retrieval into another workspace's or tenant's memory.
export interface CodingContextRequest {
  readonly schemaVersion: typeof CODING_CONTEXT_SCHEMA_VERSION;
  readonly purpose: CodingContextPurpose;
  readonly editorSessionId?: string | undefined;
  readonly documentPath: string;
  readonly symbol: string | undefined;
  readonly queryText: string | undefined;
  readonly changedFiles: readonly string[] | undefined;
  readonly capsuleId: string | undefined;
  readonly capsuleSetId: string | undefined;
}

// ─── Validation result (shared shape with connected-context) ────────────────────────
export type CodingContextValidationResult =
  { readonly ok: true } | { readonly ok: false; readonly reasons: readonly string[] };

// ─── Helpers ────────────────────────────────────────────────────────────────────
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isOptionalStringArray(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.every((v) => typeof v === "string"));
}

export function isCodingContextPurpose(value: unknown): value is CodingContextPurpose {
  return (
    typeof value === "string" && CODING_CONTEXT_PURPOSES.includes(value as CodingContextPurpose)
  );
}

// Returns the trust tier for a source kind. Total over the source-kind union.
export function tierForCodingContextSource(kind: CodingContextSourceKind): CodingContextSourceTier {
  return CODING_CONTEXT_SOURCE_TIER_BY_KIND[kind];
}

// Whether embedding-cost providers (Local Knowledge, memory) may run for this purpose. The single
// authority for the per-keystroke exclusion rule (Issue #1211 AC3).
export function embeddingProvidersAllowed(purpose: CodingContextPurpose): boolean {
  return CODING_CONTEXT_BUDGETS[purpose].allowEmbeddingProviders;
}

// Structural content-free check: a value is a wire-safe citation only if it has no excerpt/content/
// text/raw fields. Used as a defense-in-depth guard before a citation reaches the browser or an
// evidence record.
function citationShapeValid(value: Record<string, unknown>): boolean {
  return [
    CODING_CONTEXT_SOURCE_KINDS.includes(value.sourceKind as CodingContextSourceKind),
    CODING_CONTEXT_SOURCE_TIERS.includes(value.sourceTier as CodingContextSourceTier),
    typeof value.id === "string",
    typeof value.score === "number",
    typeof value.rank === "number",
    typeof value.byteCount === "number",
    typeof value.truncated === "boolean",
    isOptionalString(value.citationRef),
  ].every(Boolean);
}

export function isCodingContextCitation(value: unknown): value is CodingContextCitation {
  if (!isRecord(value)) {
    return false;
  }
  if ("text" in value || "excerpt" in value || "content" in value) {
    return false;
  }
  return citationShapeValid(value);
}

// Projects a content-bearing pack to its content-free wire/evidence form by dropping excerpt text.
// Pure: the same pack always yields the same wire pack.
export function toCodingContextWirePack(pack: CodingContextPack): CodingContextWirePack {
  return {
    schemaVersion: pack.schemaVersion,
    purpose: pack.purpose,
    entries: pack.excerpts.map((excerpt) => excerpt.citation),
    usedBytes: pack.usedBytes,
    budgetBytes: pack.budgetBytes,
    droppedForBudget: pack.droppedForBudget,
    omissions: pack.omissions,
  };
}

// Validates a coding-context request parsed from the BFF wire. `documentPath` must be present and
// relative; absolute/escaping containment is enforced separately at the route layer (realpath gate).
export function validateCodingContextRequest(value: unknown): CodingContextValidationResult {
  if (!isRecord(value)) {
    return { ok: false, reasons: ["request invalid"] };
  }
  const checks: readonly (readonly [boolean, string])[] = [
    [value.schemaVersion === CODING_CONTEXT_SCHEMA_VERSION, "request.schemaVersion invalid"],
    [isCodingContextPurpose(value.purpose), "request.purpose invalid"],
    [
      value.editorSessionId === undefined || isNonEmptyString(value.editorSessionId),
      "request.editorSessionId invalid",
    ],
    [isNonEmptyString(value.documentPath), "request.documentPath empty"],
    [isOptionalString(value.symbol), "request.symbol invalid"],
    [isOptionalString(value.queryText), "request.queryText invalid"],
    [isOptionalStringArray(value.changedFiles), "request.changedFiles invalid"],
    [isOptionalString(value.capsuleId), "request.capsuleId invalid"],
    [isOptionalString(value.capsuleSetId), "request.capsuleSetId invalid"],
    [
      !(typeof value.capsuleId === "string" && typeof value.capsuleSetId === "string"),
      "request.localKnowledgeScope ambiguous",
    ],
  ];
  const reasons = checks.filter(([ok]) => !ok).map(([, reason]) => reason);
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}
