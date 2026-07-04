// Shared browser-safe display-field validation for Local Knowledge write paths (GEN-DUP-SEMANTIC-006).
//
// The compound "non-empty, trimmed, and browser-safe" rule for user-facing display fields (capsule /
// capsule-set / source names, descriptions, and tags) was re-inlined byte-for-byte across four write
// modules (capsule-lifecycle, capsule-set-lifecycle, source-lifecycle, composition). This is its single
// owner. The safety predicate itself — `isSafeDisplaySummary` (length bound + control-character reject)
// — is the keiko-contracts canonical; these thin asserts add the non-empty-trimmed requirement for the
// required variant and raise the domain `KnowledgeStoreError` with the exact prior messages, so every
// write path enforces one identical rule.
import { isSafeDisplaySummary } from "@oscharko-dev/keiko-contracts";

import { KnowledgeStoreError } from "./errors.js";

/** A required display field must be a non-empty, trimmed, browser-safe string. */
export function assertSafeDisplayField(field: string, value: string): void {
  if (value.trim().length === 0 || !isSafeDisplaySummary(value)) {
    throw new KnowledgeStoreError(`${field} must be a browser-safe non-empty string`);
  }
}

/** An optional display field, when present, must be browser-safe (non-emptiness is not required). */
export function assertSafeOptionalDisplayField(field: string, value: string | undefined): void {
  if (value !== undefined && !isSafeDisplaySummary(value)) {
    throw new KnowledgeStoreError(`${field} must be browser-safe when set`);
  }
}
