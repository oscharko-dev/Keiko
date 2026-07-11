// Shared fingerprint-set diff (Epic #1856 → generalized for Epic #2238, Issue #2242).
//
// THE single change-classification engine for every fingerprint-based refresh in Local Knowledge.
// Extracted verbatim from `manual-refresh-change-summary.ts`'s page diff so the connector sync
// lane (ADR-0128 D5) reuses the same implementation instead of growing a second diff engine:
//
//   - HTML manual refresh: keys are scope-relative page paths; `detectMoves: true` correlates a
//     same-content removed+added pair into a "moved" page (paths are resolved locations, so a
//     rename shows up as a move).
//   - Connector sync: keys are stable provider item identities (`confluence:<connectorId>:<pageId>`);
//     `detectMoves: false` because a provider-assigned id never moves — ADR-0128 D5 drops the
//     moved category for connector items by construction.
//
// Pure and body-free: inputs are key → opaque-content-fingerprint maps; no path, body, or
// diagnostic string is interpreted or emitted.

export interface FingerprintSetDelta {
  readonly added: number;
  readonly changed: number;
  readonly removed: number;
  readonly moved: number;
  readonly unchanged: number;
}

export interface FingerprintDiffOptions {
  readonly detectMoves: boolean;
}

// Keys present in `prior` but absent from the new set, tallied by their content fingerprint — the
// candidate set a same-fingerprint added key can be correlated against to detect a move.
function removedFingerprintTallies(
  prior: ReadonlyMap<string, string>,
  nextKeys: ReadonlySet<string>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const [key, fingerprint] of prior) {
    if (nextKeys.has(key)) continue;
    counts.set(fingerprint, (counts.get(fingerprint) ?? 0) + 1);
  }
  return counts;
}

function classifyNewKeys(
  prior: ReadonlyMap<string, string>,
  next: ReadonlyMap<string, string>,
  availableMoveSources: Map<string, number>,
): Omit<FingerprintSetDelta, "removed"> {
  let added = 0;
  let changed = 0;
  let moved = 0;
  let unchanged = 0;
  for (const [key, fingerprint] of next) {
    const previous = prior.get(key);
    if (previous === undefined) {
      // A same-content key whose old key was removed this run is a move, not an unrelated
      // remove+add pair — correlate by content fingerprint and consume one source per match so
      // two new keys sharing a fingerprint cannot both claim the same removed key as a move.
      const available = availableMoveSources.get(fingerprint) ?? 0;
      if (available > 0) {
        availableMoveSources.set(fingerprint, available - 1);
        moved += 1;
      } else {
        added += 1;
      }
    } else if (previous === fingerprint) {
      unchanged += 1;
    } else {
      changed += 1;
    }
  }
  return { added, changed, moved, unchanged };
}

// Diff two key → content-fingerprint sets into added/changed/removed/moved/unchanged counts.
// With `detectMoves: false` the moved count is always 0 and a relocated same-content entry counts
// as one removed + one added (which cannot occur for stable provider ids).
export function diffFingerprintSets(
  prior: ReadonlyMap<string, string>,
  next: ReadonlyMap<string, string>,
  options: FingerprintDiffOptions,
): FingerprintSetDelta {
  const nextKeys = new Set(next.keys());
  const availableMoveSources = options.detectMoves
    ? removedFingerprintTallies(prior, nextKeys)
    : new Map<string, number>();
  const classified = classifyNewKeys(prior, next, availableMoveSources);
  let removed = 0;
  for (const key of prior.keys()) {
    if (!nextKeys.has(key)) removed += 1;
  }
  removed -= classified.moved;
  return { ...classified, removed };
}
