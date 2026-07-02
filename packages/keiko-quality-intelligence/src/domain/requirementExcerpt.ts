// Human-readable requirement excerpt for coverage/traceability surfaces (Epic #734, Issue #790).
//
// Coverage matrix rows, gap findings and the traceability matrix historically carried atom ids
// only — auditors could not tell WHICH requirement `qi-atom-…` is without manually cross-
// referencing the source. This helper derives a short, redaction-safe excerpt from an atom's
// server-side canonical text so those surfaces become auditor-readable without ever persisting
// raw source content.
//
// Ordering is load-bearing: unsafe bidi/zero-width/control code points are stripped FIRST, then the
// FULL text is redacted, then whitespace-collapsed, then truncated.
//   * Stripping before redaction is a redaction SAFEGUARD, not just cosmetics: a credential
//     obfuscated by an interstitial zero-width character (e.g. an AWS key with a U+200B inside it)
//     slips past redact() — whose patterns match contiguous characters — and would survive into the
//     excerpt. Removing the spoofing code points first de-obfuscates the text so redact() sees, and
//     scrubs, the real secret. It also keeps the audit-ready coverage/traceability surfaces free of
//     invisible/bidi characters (symmetric with the candidate-text chokepoint normaliseCandidateText).
//   * Truncating before redaction could split a secret across the cut so the remainder no longer
//     matches any redaction pattern (a partial AWS key is still a leak); redacting first makes the
//     truncation operate on already-safe text.
// Persistence redacts every string leaf again (defense in depth), so a stored excerpt is redacted at
// least twice; the format-char strip sits upstream of every persisted coverage/finding/export surface.

import { redact } from "@oscharko-dev/keiko-security";

import { stripUnsafeFormatChars } from "./assertions.js";

/** Maximum excerpt length in characters, including the trailing ellipsis. */
export const REQUIREMENT_EXCERPT_MAX_CHARS = 96 as const;

const ELLIPSIS = "…";
const EMAIL_ADDRESS_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu;
const REDACTED = "[REDACTED]";

const redactExcerptText = (value: string): string =>
  redact(value).replace(EMAIL_ADDRESS_PATTERN, REDACTED);

/**
 * Build a short, redacted, single-line excerpt of an atom's canonical text. Returns `undefined`
 * for empty/whitespace-only input so callers can simply omit the optional field. Deterministic:
 * same input always yields the same excerpt (no timestamps, no randomness).
 */
export function buildRequirementExcerpt(canonicalText: string): string | undefined {
  const collapsed = redactExcerptText(stripUnsafeFormatChars(canonicalText))
    .replace(/\s+/gu, " ")
    .trim();
  if (collapsed.length === 0) return undefined;
  if (collapsed.length <= REQUIREMENT_EXCERPT_MAX_CHARS) return collapsed;
  return collapsed.slice(0, REQUIREMENT_EXCERPT_MAX_CHARS - ELLIPSIS.length).trimEnd() + ELLIPSIS;
}
