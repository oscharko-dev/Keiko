// Closed coding profile over the pillar-neutral retrieval-context contract (Issue #2570,
// ADR-0152 D6). Existing coding wire fields, literals, order, schema version, and validation remain
// byte-identical. Neutral-only purposes and source kinds are deliberately rejected here.

import { EDITOR_AGENT_SESSION_ID_MAX_BYTES } from "./editor-agent.js";
import { isPortableWorkspaceRelativePath } from "./workspace-contract-primitives.js";
import type { CostClass } from "./gateway.js";
import {
  CODING_CONTEXT_PURPOSES,
  CODING_CONTEXT_SOURCE_KINDS,
  CODING_CONTEXT_SOURCE_TIER_BY_KIND,
  RETRIEVAL_CONTEXT_SCHEMA_VERSION,
  isValidContextCitation,
  toRetrievalContextWirePack,
  type CodingContextPurpose,
  type CodingContextSourceKind,
  type CodingContextSourceTier,
  type RetrievalContextBudget,
  type RetrievalContextCitation,
  type RetrievalContextExcerpt,
  type RetrievalContextOmission,
  type RetrievalContextOmissionReason,
  type RetrievalContextPack,
  type RetrievalContextRequest,
  type RetrievalContextScopeKind,
  type RetrievalContextWirePack,
} from "./retrieval-context.js";

// The schema version is re-declared rather than re-exported because this module also compares
// against it (validateCodingContextRequest below); the rest are pure pass-throughs, and the
// coding-profile names for the tier and omission catalogs are aliases / derivations, not new values
// (CODING_CONTEXT_SOURCE_TIER_BY_KIND / CODING_CONTEXT_SOURCE_TIERS / CodingContextSourceTier are
// each derived FROM the coding profile's own pinned mapping in retrieval-context.ts, not aliased to
// the neutral RETRIEVAL_CONTEXT_SOURCE_TIERS / RetrievalContextSourceTier — see the comment there).
export const CODING_CONTEXT_SCHEMA_VERSION = RETRIEVAL_CONTEXT_SCHEMA_VERSION;
export { CODING_CONTEXT_PURPOSES, CODING_CONTEXT_SOURCE_KINDS, CODING_CONTEXT_SOURCE_TIER_BY_KIND };
export {
  CODING_CONTEXT_BUDGETS,
  CODING_CONTEXT_SOURCE_TIERS,
  embeddingProvidersAllowed,
  RETRIEVAL_CONTEXT_OMISSION_REASONS as CODING_CONTEXT_OMISSION_REASONS,
} from "./retrieval-context.js";

export type { CodingContextPurpose, CodingContextSourceKind, CodingContextSourceTier };
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

// Shared across the package (KEIKO-0159): isRecord below and the four primitives in the "Shared
// completion-contract primitives" section further down used to be re-implemented byte-for-byte in
// editor-completion.ts, editor-inline-completion.ts, and editor-test-generation.ts -- all three
// already import isBoundedEditorSessionId from here, so this is the natural single home.
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Trim-sensitive on purpose: isBoundedEditorSessionId and the documentPath check below must keep
// rejecting a whitespace-only value exactly as they always have (isBoundedEditorSessionId is
// covered by existing round-trip tests through parseEditorCompletionRequest et al.). This is
// deliberately NOT the shared, exported `isNonEmptyString` below -- that one preserves the
// completion contracts' own, non-trimming historical semantics for `root` and `componentName`, and
// merging the two would silently change one surface or the other.
function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isBoundedEditorSessionId(value: unknown): value is string {
  return (
    isNonBlankString(value) &&
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
  if (!isNonBlankString(value) || value.length > CODING_CONTEXT_PATH_MAX_CHARS) return false;
  // eslint-disable-next-line no-control-regex -- rejecting C0/DEL in a path is the point
  return !/[\u0000-\u001f\u007f]/u.test(value);
}

function isOptionalWorkspaceRelativePathList(value: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length > CODING_CONTEXT_CHANGED_FILES_MAX_COUNT) return false;
  return value.every((entry) => isNonBlankString(entry) && isPortableWorkspaceRelativePath(entry));
}

// ─── Shared completion-contract primitives (KEIKO-0159) ────────────────────────────────────────────
// Moved out of editor-completion.ts / editor-inline-completion.ts / editor-test-generation.ts, which
// each defined byte-identical copies of collectContextErrors, buildContextSelectors, and the
// primitive guards below. isNonEmptyString here is deliberately NOT trim-sensitive (unlike the
// module-private isNonBlankString above) -- it preserves the three completion contracts' own,
// pre-existing `root`/`componentName` semantics exactly.
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export function isCostClass(value: unknown): value is CostClass {
  return value === "low" || value === "medium" || value === "high";
}

export function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

// Identical invariant message across all three completion contracts; factored here so the wording
// and the EDITOR_AGENT_SESSION_ID_MAX_BYTES bound it quotes cannot drift between them.
export function collectEditorSessionIdError(value: unknown, errors: string[]): void {
  if (value !== undefined && !isBoundedEditorSessionId(value)) {
    errors.push(
      `editorSessionId must be a non-empty string of at most ${EDITOR_AGENT_SESSION_ID_MAX_BYTES.toString()} UTF-8 bytes when provided`,
    );
  }
}

// The optional, content-bearing coding-context selectors shared by the completion, inline-completion,
// and test-generation wire requests. Structurally identical to (and mutually assignable with) each
// contract's own EditorCompletionContextSelectors-shaped field -- no import of that type is needed
// here, which keeps this module's existing one-directional dependency (the three contracts import
// FROM coding-context.ts, not the reverse).
export interface CodingContextSelectors {
  readonly queryText?: string;
  readonly symbol?: string;
  readonly changedFiles?: readonly string[];
  readonly capsuleId?: string;
  readonly capsuleSetId?: string;
}

// Collects the optional, content-bearing context selectors. Unknown-typed fields are rejected so a
// malformed selector cannot silently widen retrieval; an absent `context` is valid.
export function collectContextErrors(context: unknown, errors: string[]): void {
  if (context === undefined) {
    return;
  }
  if (!isRecord(context)) {
    errors.push("context must be an object when provided");
    return;
  }
  for (const field of ["queryText", "symbol", "capsuleId", "capsuleSetId"] as const) {
    if (context[field] !== undefined && typeof context[field] !== "string") {
      errors.push(`context.${field} must be a string when provided`);
    }
  }
  if (context.changedFiles !== undefined && !isStringArray(context.changedFiles)) {
    errors.push("context.changedFiles must be an array of strings when provided");
  }
  if (context.capsuleId !== undefined && context.capsuleSetId !== undefined) {
    errors.push("context must not set both capsuleId and capsuleSetId");
  }
}

export function buildContextSelectors(context: Record<string, unknown>): CodingContextSelectors {
  return {
    ...(typeof context.queryText === "string" ? { queryText: context.queryText } : {}),
    ...(typeof context.symbol === "string" ? { symbol: context.symbol } : {}),
    ...(isStringArray(context.changedFiles) ? { changedFiles: context.changedFiles } : {}),
    ...(typeof context.capsuleId === "string" ? { capsuleId: context.capsuleId } : {}),
    ...(typeof context.capsuleSetId === "string" ? { capsuleSetId: context.capsuleSetId } : {}),
  };
}

export function isCodingContextPurpose(value: unknown): value is CodingContextPurpose {
  return (
    typeof value === "string" && CODING_CONTEXT_PURPOSES.includes(value as CodingContextPurpose)
  );
}

export function tierForCodingContextSource(kind: CodingContextSourceKind): CodingContextSourceTier {
  return CODING_CONTEXT_SOURCE_TIER_BY_KIND[kind];
}

// Validates against the CODING profile's own sourceKind set and tier table
// (CODING_CONTEXT_SOURCE_TIER_BY_KIND), not the neutral one — connected-context deliberately
// carries a different tier in each (see the comment on isValidContextCitation in
// retrieval-context.ts), so delegating to isRetrievalContextCitation would reject a citation this
// module's own tierForCodingContextSource produces.
export function isCodingContextCitation(value: unknown): value is CodingContextCitation {
  return isValidContextCitation(
    value,
    CODING_CONTEXT_SOURCE_KINDS,
    CODING_CONTEXT_SOURCE_TIER_BY_KIND,
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
