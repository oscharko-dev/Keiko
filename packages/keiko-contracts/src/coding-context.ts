// Closed coding profile over the pillar-neutral retrieval-context contract (Issue #2570,
// ADR-0152 D6). Existing coding wire fields, literals, order, schema version, and validation remain
// byte-identical. Neutral-only purposes and source kinds are deliberately rejected here.

import { EDITOR_AGENT_SESSION_ID_MAX_BYTES } from "./editor-agent.js";
import { isPortableWorkspaceRelativePath } from "./workspace-contract-primitives.js";
import {
  CODING_CONTEXT_PURPOSES,
  CODING_CONTEXT_SOURCE_KINDS,
  CODING_CONTEXT_SOURCE_TIER_BY_KIND,
  RETRIEVAL_CONTEXT_SCHEMA_VERSION,
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

// The schema version is re-declared rather than re-exported because this module also compares
// against it (validateCodingContextRequest below); the rest are pure pass-throughs, and the
// coding-profile names for the neutral tier and omission catalogs are aliases, not new values.
export const CODING_CONTEXT_SCHEMA_VERSION = RETRIEVAL_CONTEXT_SCHEMA_VERSION;
export { CODING_CONTEXT_PURPOSES, CODING_CONTEXT_SOURCE_KINDS, CODING_CONTEXT_SOURCE_TIER_BY_KIND };
export {
  CODING_CONTEXT_BUDGETS,
  embeddingProvidersAllowed,
  RETRIEVAL_CONTEXT_OMISSION_REASONS as CODING_CONTEXT_OMISSION_REASONS,
  RETRIEVAL_CONTEXT_SOURCE_TIERS as CODING_CONTEXT_SOURCE_TIERS,
} from "./retrieval-context.js";

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

// Per-field bounds for the request boundary. Without them the only bounded field was
// editorSessionId, so a traversal documentPath and multi-megabyte free text both returned ok:true
// from a validator whose callers reasonably read that as "vetted". The changed-file cap is the same
// number keiko-server's MAX_CONTEXT_CHANGED_FILES enforces on the route, so the two agree.
export const CODING_CONTEXT_SYMBOL_MAX_CHARS = 512;
export const CODING_CONTEXT_QUERY_TEXT_MAX_CHARS = 4_096;
export const CODING_CONTEXT_CAPSULE_ID_MAX_CHARS = 128;
export const CODING_CONTEXT_CHANGED_FILES_MAX_COUNT = 64;

// A PRESENT optional string must carry something: `undefined` is the documented absent case, so a
// blank or whitespace-only symbol/queryText/capsuleId is a malformed value rather than an omission —
// and a whitespace-only capsuleId would otherwise reach the Local Knowledge scope selector as if it
// named a capsule.
function isBoundedOptionalString(value: unknown, maxChars: number): boolean {
  if (value === undefined) return true;
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxChars;
}

// documentPath is BOUNDED and character-checked here, but its containment verdict is deliberately
// left to the route: keiko-server answers 403 DENIED for a path that escapes the workspace root — an
// authority outcome, not a malformed-request one — and that status is pinned. Rejecting traversal
// structurally here would collapse a workspace-escape attempt into a generic 400 and lose the
// governance signal.
export const CODING_CONTEXT_PATH_MAX_CHARS = 4_096;

function isBoundedDocumentPath(value: unknown): value is string {
  if (!isNonEmptyString(value) || value.length > CODING_CONTEXT_PATH_MAX_CHARS) return false;
  // eslint-disable-next-line no-control-regex -- rejecting C0/DEL in a path is the point
  return !/[\u0000-\u001f\u007f]/u.test(value);
}

function isOptionalWorkspaceRelativePathList(value: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length > CODING_CONTEXT_CHANGED_FILES_MAX_COUNT) return false;
  return value.every((entry) => isNonEmptyString(entry) && isPortableWorkspaceRelativePath(entry));
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
    [isBoundedDocumentPath(value.documentPath), "request.documentPath invalid"],
    [
      isBoundedOptionalString(value.symbol, CODING_CONTEXT_SYMBOL_MAX_CHARS),
      "request.symbol invalid",
    ],
    [
      isBoundedOptionalString(value.queryText, CODING_CONTEXT_QUERY_TEXT_MAX_CHARS),
      "request.queryText invalid",
    ],
    [isOptionalWorkspaceRelativePathList(value.changedFiles), "request.changedFiles invalid"],
    [
      isBoundedOptionalString(value.capsuleId, CODING_CONTEXT_CAPSULE_ID_MAX_CHARS),
      "request.capsuleId invalid",
    ],
    [
      isBoundedOptionalString(value.capsuleSetId, CODING_CONTEXT_CAPSULE_ID_MAX_CHARS),
      "request.capsuleSetId invalid",
    ],
    [
      !(typeof value.capsuleId === "string" && typeof value.capsuleSetId === "string"),
      "request.localKnowledgeScope ambiguous",
    ],
  ];
  const reasons = checks.filter(([ok]) => !ok).map(([, reason]) => reason);
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}
