// Closed coding profile over the pillar-neutral retrieval-context contract (Issue #2570,
// ADR-0152 D6). Existing coding wire fields, literals, order, schema version, and validation remain
// byte-identical. Neutral-only purposes and source kinds are deliberately rejected here.

import { EDITOR_AGENT_SESSION_ID_MAX_BYTES } from "./editor-agent.js";
import {
  CODING_CONTEXT_BUDGETS,
  CODING_CONTEXT_PURPOSES,
  CODING_CONTEXT_SOURCE_KINDS,
  CODING_CONTEXT_SOURCE_TIER_BY_KIND,
  RETRIEVAL_CONTEXT_OMISSION_REASONS,
  RETRIEVAL_CONTEXT_SCHEMA_VERSION,
  RETRIEVAL_CONTEXT_SOURCE_TIERS,
  embeddingProvidersAllowed,
  isRetrievalContextCitation,
  toRetrievalContextWirePack,
  type CodingContextPurpose,
  type CodingContextSourceKind,
  type RetrievalContextBudget,
  type RetrievalContextCitation,
  type RetrievalContextExcerpt,
  type RetrievalContextOmission,
  type RetrievalContextOmissionReason,
  type RetrievalContextPack,
  type RetrievalContextRequest,
  type RetrievalContextScopeKind,
  type RetrievalContextSourceTier,
  type RetrievalContextWirePack,
} from "./retrieval-context.js";

export const CODING_CONTEXT_SCHEMA_VERSION = RETRIEVAL_CONTEXT_SCHEMA_VERSION;
export {
  CODING_CONTEXT_BUDGETS,
  CODING_CONTEXT_PURPOSES,
  CODING_CONTEXT_SOURCE_KINDS,
  CODING_CONTEXT_SOURCE_TIER_BY_KIND,
  embeddingProvidersAllowed,
};
export const CODING_CONTEXT_SOURCE_TIERS = RETRIEVAL_CONTEXT_SOURCE_TIERS;
export const CODING_CONTEXT_OMISSION_REASONS = RETRIEVAL_CONTEXT_OMISSION_REASONS;

export type { CodingContextPurpose, CodingContextSourceKind };
export type CodingContextSourceTier = RetrievalContextSourceTier;
export type CodingContextOmissionReason = RetrievalContextOmissionReason;
export type CodingContextOmission = RetrievalContextOmission<CodingContextSourceKind>;
export type CodingContextCitation = RetrievalContextCitation<CodingContextSourceKind>;
export type CodingContextExcerpt = RetrievalContextExcerpt<CodingContextSourceKind>;
export type CodingContextPack = RetrievalContextPack<CodingContextSourceKind, CodingContextPurpose>;
export type CodingContextWirePack = RetrievalContextWirePack<
  CodingContextSourceKind,
  CodingContextPurpose
>;
export type CodingContextBudget = RetrievalContextBudget;
export type CodingContextScopeKind = RetrievalContextScopeKind;
export type CodingContextRequest = RetrievalContextRequest<CodingContextPurpose> & {
  readonly documentPath: string;
  readonly symbol: string | undefined;
  readonly queryText: string | undefined;
  readonly changedFiles: readonly string[] | undefined;
  readonly capsuleId: string | undefined;
  readonly capsuleSetId: string | undefined;
};

export type CodingContextValidationResult =
  { readonly ok: true } | { readonly ok: false; readonly reasons: readonly string[] };

const EDITOR_SESSION_ID_TEXT_ENCODER = new TextEncoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isBoundedEditorSessionId(value: unknown): value is string {
  return (
    isNonEmptyString(value) &&
    EDITOR_SESSION_ID_TEXT_ENCODER.encode(value).length <= EDITOR_AGENT_SESSION_ID_MAX_BYTES
  );
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

export function tierForCodingContextSource(kind: CodingContextSourceKind): CodingContextSourceTier {
  return CODING_CONTEXT_SOURCE_TIER_BY_KIND[kind];
}

export function isCodingContextCitation(value: unknown): value is CodingContextCitation {
  return (
    isRetrievalContextCitation(value) &&
    CODING_CONTEXT_SOURCE_KINDS.includes(value.sourceKind as CodingContextSourceKind)
  );
}

export function toCodingContextWirePack(pack: CodingContextPack): CodingContextWirePack {
  return toRetrievalContextWirePack(pack);
}

export function validateCodingContextRequest(value: unknown): CodingContextValidationResult {
  if (!isRecord(value)) {
    return { ok: false, reasons: ["request invalid"] };
  }
  const checks: readonly (readonly [boolean, string])[] = [
    [value.schemaVersion === CODING_CONTEXT_SCHEMA_VERSION, "request.schemaVersion invalid"],
    [isCodingContextPurpose(value.purpose), "request.purpose invalid"],
    [
      value.editorSessionId === undefined || isBoundedEditorSessionId(value.editorSessionId),
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
