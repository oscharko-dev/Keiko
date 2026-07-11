// Shared validation + canonicalisation for figma-snapshot `screenIds` scoping (Epic #750, Issue #754).
//
// Both the start-run route (runRoutes.ts) and the drift re-check / regenerate route (reCheckRoutes.ts)
// accept figma-snapshot sources that MAY carry an optional `screenIds` array scoping ingestion to
// specific masks of a large board. This module is the SINGLE source of truth so the two routes can
// never diverge on what they accept — the audit's run/recheck-parity requirement.
//
// Invariants enforced here:
//   - `screenIds` ABSENT  → whole-snapshot source (returns `undefined`; the contract's "absent = whole").
//   - `screenIds` PRESENT → must be a NON-EMPTY array of non-empty, bounded, string ids. An explicit
//     empty array is REJECTED: a scoped source with zero screens is meaningless, and left unchecked the
//     server's `scopedParsedScreens` treats an empty screen list as "all screens" — silently widening a
//     scoped request to the whole board (the scoped-snapshot leak this guard closes).
//   - Each id is trimmed, must be non-empty and within the length cap; the array count is capped.
//   - The result is CANONICAL (deduplicated + sorted) so the derived envelope id / provenance ref is
//     stable regardless of the order or duplicates the client sent, and dedupe across reconnections and
//     re-check is exact.

/** Upper bound on the number of scoped screen ids in one figma-snapshot source (DoS / payload guard). */
export const MAX_FIGMA_SCREEN_IDS = 200;

/** Upper bound on a single screen id's length (mirrors the UI persistence reference-value cap). */
export const MAX_FIGMA_SCREEN_ID_LENGTH = 256;

export type FigmaScreenIdsResult =
  | { readonly ok: true; readonly screenIds: readonly string[] | undefined }
  | { readonly ok: false; readonly reason: string };

/**
 * Validate and canonicalise the optional `screenIds` field of an incoming figma-snapshot source.
 * Returns `{ ok: true, screenIds: undefined }` when the field is absent (whole-snapshot source),
 * `{ ok: true, screenIds }` with a deduplicated, sorted, bounded list when it is a valid scope, or
 * `{ ok: false, reason }` with a user-actionable message when it is malformed / empty / oversized.
 */
export function parseFigmaSnapshotScreenIds(raw: unknown): FigmaScreenIdsResult {
  if (raw === undefined) return { ok: true, screenIds: undefined };
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      reason: "A figma-snapshot source screenIds field must be an array of screen ids.",
    };
  }
  if (raw.length === 0) {
    return {
      ok: false,
      reason:
        "A figma-snapshot source screenIds field, when present, must list at least one screen id.",
    };
  }
  if (raw.length > MAX_FIGMA_SCREEN_IDS) {
    return {
      ok: false,
      reason: `A figma-snapshot source may scope at most ${String(MAX_FIGMA_SCREEN_IDS)} screen ids.`,
    };
  }
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") {
      return {
        ok: false,
        reason: "A figma-snapshot source screenIds field must contain non-empty strings.",
      };
    }
    const screenId = item.trim();
    if (screenId.length === 0) {
      return {
        ok: false,
        reason: "A figma-snapshot source screenIds field must contain non-empty strings.",
      };
    }
    if (screenId.length > MAX_FIGMA_SCREEN_ID_LENGTH) {
      return {
        ok: false,
        reason: `A figma-snapshot source screen id exceeds the ${String(MAX_FIGMA_SCREEN_ID_LENGTH)}-character limit.`,
      };
    }
    seen.add(screenId);
  }
  // Canonical: dedupe (Set) + sort so the derived envelope id / provenance ref is order- and
  // duplicate-stable, and dedupe across reconnections / re-check is exact.
  return { ok: true, screenIds: [...seen].sort((a, b) => a.localeCompare(b)) };
}
