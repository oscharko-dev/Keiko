// Human-readable requirement excerpt for coverage/traceability surfaces (Epic #734, Issue #790).
//
// Coverage matrix rows, gap findings and the traceability matrix historically carried atom ids
// only — auditors could not tell WHICH requirement `qi-atom-…` is without manually cross-
// referencing the source. This helper derives a short, redaction-safe excerpt from an atom's
// server-side canonical text so those surfaces become auditor-readable without ever persisting
// raw source content.
//
// Ordering is load-bearing: the FULL text is redacted FIRST, then whitespace-collapsed, then
// truncated. Truncating before redaction could split a secret across the cut so the remainder no
// longer matches any redaction pattern (a partial AWS key is still a leak); redacting first makes
// the truncation operate on already-safe text. Persistence redacts every string leaf again
// (defense in depth), so a stored excerpt is redacted at least twice.

import { redact } from "@oscharko-dev/keiko-security";

/** Maximum excerpt length in characters, including the trailing ellipsis. */
export const REQUIREMENT_EXCERPT_MAX_CHARS = 96 as const;

const ELLIPSIS = "…";

/**
 * Build a short, redacted, single-line excerpt of an atom's canonical text. Returns `undefined`
 * for empty/whitespace-only input so callers can simply omit the optional field. Deterministic:
 * same input always yields the same excerpt (no timestamps, no randomness).
 */
export function buildRequirementExcerpt(canonicalText: string): string | undefined {
  const collapsed = redact(canonicalText).replace(/\s+/gu, " ").trim();
  if (collapsed.length === 0) return undefined;
  if (collapsed.length <= REQUIREMENT_EXCERPT_MAX_CHARS) return collapsed;
  return collapsed.slice(0, REQUIREMENT_EXCERPT_MAX_CHARS - ELLIPSIS.length).trimEnd() + ELLIPSIS;
}
