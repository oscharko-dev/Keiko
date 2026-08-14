// Pillar-neutral governed retrieval-context contracts (Issue #2570, ADR-0152 D6).
// RetrievalContextPack is server-internal and content-bearing; RetrievalContextWirePack is the
// content-free projection that may cross a wire or enter evidence. Retrieved content never grants
// authority. New source kinds land in this neutral vocabulary first: promoting one into the closed
// coding profile is a separate schema decision with editor, harness, and UI lockstep review.
//
// The repository pod continues to use Local Knowledge's existing `repository` scope kind. A future
// repository-pod-backed context provider must add its source kind here before any deliberate coding
// profile promotion; it must not create a second pack vocabulary.

export const RETRIEVAL_CONTEXT_SCHEMA_VERSION = "1" as const;

export type CodingContextPurpose =
  "inline" | "completion" | "test-generation" | "explain" | "diagnostic";

export const CODING_CONTEXT_PURPOSES: readonly CodingContextPurpose[] = [
  "inline",
  "completion",
  "test-generation",
  "explain",
  "diagnostic",
] as const;

export type RetrievalPurpose = CodingContextPurpose | "chat-grounding";

export const RETRIEVAL_CONTEXT_PURPOSES: readonly RetrievalPurpose[] = [
  ...CODING_CONTEXT_PURPOSES,
  "chat-grounding",
] as const;

export type CodingContextSourceKind =
  | "repo-search"
  | "connected-context"
  | "local-knowledge"
  | "memory"
  | "quality-intelligence"
  | "workflow-context"
  | "files-focus"
  | "editor-state"
  | "git-context";

export const CODING_CONTEXT_SOURCE_KINDS: readonly CodingContextSourceKind[] = [
  "repo-search",
  "connected-context",
  "local-knowledge",
  "memory",
  "quality-intelligence",
  "workflow-context",
  "files-focus",
  "editor-state",
  "git-context",
] as const;

export type RetrievalContextSourceKind =
  CodingContextSourceKind | "graph-relations" | "entailment-evidence";

export const RETRIEVAL_CONTEXT_SOURCE_KINDS: readonly RetrievalContextSourceKind[] = [
  ...CODING_CONTEXT_SOURCE_KINDS,
  "graph-relations",
  "entailment-evidence",
] as const;

// `external-connected` exists because connected-context carries GitHub/Jira content that anyone with
// issue- or PR-creation rights on a tracked repository can author. Bucketing it with the user's own
// files under `first-party-workspace` destroyed the one structured governance signal that tells the
// two apart, so an auditor reading an evidence manifest's tierCounts could not say how much of the
// first-party count actually originated outside the workspace. The item-level `untrusted: true`
// labelling the connector applies is a separate, additive signal — this tier does not replace it.
export type RetrievalContextSourceTier =
  | "first-party-workspace"
  | "external-connected"
  | "indexed-knowledge"
  | "retained-memory"
  | "derived-evidence";

export const RETRIEVAL_CONTEXT_SOURCE_TIERS: readonly RetrievalContextSourceTier[] = [
  "first-party-workspace",
  "external-connected",
  "indexed-knowledge",
  "retained-memory",
  "derived-evidence",
] as const;

export const RETRIEVAL_CONTEXT_SOURCE_TIER_BY_KIND: Readonly<
  Record<RetrievalContextSourceKind, RetrievalContextSourceTier>
> = {
  "repo-search": "first-party-workspace",
  "files-focus": "first-party-workspace",
  "editor-state": "first-party-workspace",
  "git-context": "first-party-workspace",
  "connected-context": "external-connected",
  "local-knowledge": "indexed-knowledge",
  memory: "retained-memory",
  "quality-intelligence": "derived-evidence",
  "workflow-context": "derived-evidence",
  "graph-relations": "indexed-knowledge",
  "entailment-evidence": "derived-evidence",
} as const;

export const CODING_CONTEXT_SOURCE_TIER_BY_KIND: Readonly<
  Record<CodingContextSourceKind, RetrievalContextSourceTier>
> = {
  "repo-search": RETRIEVAL_CONTEXT_SOURCE_TIER_BY_KIND["repo-search"],
  "files-focus": RETRIEVAL_CONTEXT_SOURCE_TIER_BY_KIND["files-focus"],
  "editor-state": RETRIEVAL_CONTEXT_SOURCE_TIER_BY_KIND["editor-state"],
  "git-context": RETRIEVAL_CONTEXT_SOURCE_TIER_BY_KIND["git-context"],
  "connected-context": RETRIEVAL_CONTEXT_SOURCE_TIER_BY_KIND["connected-context"],
  "local-knowledge": RETRIEVAL_CONTEXT_SOURCE_TIER_BY_KIND["local-knowledge"],
  memory: RETRIEVAL_CONTEXT_SOURCE_TIER_BY_KIND.memory,
  "quality-intelligence": RETRIEVAL_CONTEXT_SOURCE_TIER_BY_KIND["quality-intelligence"],
  "workflow-context": RETRIEVAL_CONTEXT_SOURCE_TIER_BY_KIND["workflow-context"],
} as const;

export type RetrievalContextOmissionReason =
  "unavailable" | "not-ready" | "denied" | "too-expensive" | "out-of-budget";

export const RETRIEVAL_CONTEXT_OMISSION_REASONS: readonly RetrievalContextOmissionReason[] = [
  "unavailable",
  "not-ready",
  "denied",
  "too-expensive",
  "out-of-budget",
] as const;

export interface RetrievalContextOmission<
  SourceKind extends RetrievalContextSourceKind = RetrievalContextSourceKind,
> {
  readonly sourceKind: SourceKind;
  readonly reason: RetrievalContextOmissionReason;
}

export interface RetrievalContextCitation<
  SourceKind extends RetrievalContextSourceKind = RetrievalContextSourceKind,
> {
  readonly sourceKind: SourceKind;
  readonly sourceTier: RetrievalContextSourceTier;
  readonly id: string;
  readonly score: number;
  readonly rank: number;
  readonly citationRef: string | undefined;
  readonly byteCount: number;
  readonly truncated: boolean;
}

export interface RetrievalContextExcerpt<
  SourceKind extends RetrievalContextSourceKind = RetrievalContextSourceKind,
> {
  readonly citation: RetrievalContextCitation<SourceKind>;
  readonly text: string;
}

export interface RetrievalContextPack<
  SourceKind extends RetrievalContextSourceKind = RetrievalContextSourceKind,
  Purpose extends RetrievalPurpose = RetrievalPurpose,
> {
  readonly schemaVersion: typeof RETRIEVAL_CONTEXT_SCHEMA_VERSION;
  readonly purpose: Purpose;
  readonly excerpts: readonly RetrievalContextExcerpt<SourceKind>[];
  readonly usedBytes: number;
  readonly budgetBytes: number;
  readonly droppedForBudget: number;
  readonly omissions: readonly RetrievalContextOmission<SourceKind>[];
}

export interface RetrievalContextWirePack<
  SourceKind extends RetrievalContextSourceKind = RetrievalContextSourceKind,
  Purpose extends RetrievalPurpose = RetrievalPurpose,
> {
  readonly schemaVersion: typeof RETRIEVAL_CONTEXT_SCHEMA_VERSION;
  readonly purpose: Purpose;
  readonly entries: readonly RetrievalContextCitation<SourceKind>[];
  readonly usedBytes: number;
  readonly budgetBytes: number;
  readonly droppedForBudget: number;
  readonly omissions: readonly RetrievalContextOmission<SourceKind>[];
}

export interface RetrievalContextBudget {
  readonly budgetBytes: number;
  readonly maxBytesPerSource: number;
  readonly allowEmbeddingProviders: boolean;
}

export const CODING_CONTEXT_BUDGETS: Readonly<
  Record<CodingContextPurpose, RetrievalContextBudget>
> = {
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

export const RETRIEVAL_CONTEXT_BUDGETS: Readonly<Record<RetrievalPurpose, RetrievalContextBudget>> =
  {
    ...CODING_CONTEXT_BUDGETS,
    "chat-grounding": {
      budgetBytes: 49_152,
      maxBytesPerSource: 12_288,
      allowEmbeddingProviders: true,
    },
  } as const;

export type RetrievalContextScopeKind = "file" | "symbol" | "selection" | "changed-set";

export interface RetrievalContextRequest<Purpose extends RetrievalPurpose = RetrievalPurpose> {
  readonly schemaVersion: typeof RETRIEVAL_CONTEXT_SCHEMA_VERSION;
  readonly purpose: Purpose;
  readonly editorSessionId?: string | undefined;
  readonly documentPath?: string | undefined;
  readonly symbol?: string | undefined;
  readonly queryText?: string | undefined;
  readonly changedFiles?: readonly string[] | undefined;
  readonly capsuleId?: string | undefined;
  readonly capsuleSetId?: string | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function retrievalCitationShapeValid(value: Record<string, unknown>): boolean {
  const sourceKindValid = RETRIEVAL_CONTEXT_SOURCE_KINDS.includes(
    value.sourceKind as RetrievalContextSourceKind,
  );
  return [
    sourceKindValid,
    RETRIEVAL_CONTEXT_SOURCE_TIERS.includes(value.sourceTier as RetrievalContextSourceTier),
    // The two membership checks above are independent, so a citation could claim a sourceKind whose
    // canonical tier is `retained-memory` while carrying `first-party-workspace` — misrepresenting
    // its own trust tier to any consumer that reads sourceTier instead of re-deriving it. The tier
    // is not an independent field: this table is its only authority.
    !sourceKindValid ||
      value.sourceTier ===
        tierForRetrievalContextSource(value.sourceKind as RetrievalContextSourceKind),
    typeof value.id === "string",
    typeof value.score === "number",
    typeof value.rank === "number",
    typeof value.byteCount === "number",
    typeof value.truncated === "boolean",
    isOptionalString(value.citationRef),
  ].every(Boolean);
}

export function isRetrievalContextPurpose(value: unknown): value is RetrievalPurpose {
  return (
    typeof value === "string" && RETRIEVAL_CONTEXT_PURPOSES.includes(value as RetrievalPurpose)
  );
}

export function tierForRetrievalContextSource(
  kind: RetrievalContextSourceKind,
): RetrievalContextSourceTier {
  return RETRIEVAL_CONTEXT_SOURCE_TIER_BY_KIND[kind];
}

export function embeddingProvidersAllowed(purpose: RetrievalPurpose): boolean {
  return RETRIEVAL_CONTEXT_BUDGETS[purpose].allowEmbeddingProviders;
}

export function isRetrievalContextCitation(value: unknown): value is RetrievalContextCitation {
  if (!isRecord(value)) return false;
  if ("text" in value || "excerpt" in value || "content" in value) return false;
  return retrievalCitationShapeValid(value);
}

export function toRetrievalContextWirePack<
  SourceKind extends RetrievalContextSourceKind,
  Purpose extends RetrievalPurpose,
>(pack: RetrievalContextPack<SourceKind, Purpose>): RetrievalContextWirePack<SourceKind, Purpose> {
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
